"""
图片压缩

★ 分两条路，因为运行环境里只有标准库：

  PNG   → 纯标准库无损重压（zlib + struct 手工解析）
          必定可用，且是**无损**的：解码成原始扫描线再用 zlib -9 重编码，
          顺带丢掉辅助块。通常能省 5%~30%。

  JPEG/WebP → 有损重编码标准库做不了，交给本机工具：
          cwebp → ffmpeg → ImageMagick(magick/convert)，按序探测。
          一个都没有就明确报"没装"，绝不假装成功。

★ 为什么不引入 Pillow：
  PyInstaller 打包时 Pillow 会带一堆平台相关的二进制，三平台构建极易翻车。
  桌面版的意义恰恰是"能调用你电脑上已经装好的程序"，所以走 exec。
"""
import os
import shutil
import struct
import zlib

PNG_SIG = b'\x89PNG\r\n\x1a\n'
EXTS = ('.png', '.jpg', '.jpeg', '.webp')


# ---------------------------------------------------------------- PNG 解码
def _chunks(data):
    """切出 PNG 块：[(type, payload), ...]"""
    if not data.startswith(PNG_SIG):
        raise ValueError('不是 PNG')
    out = []
    i = 8
    n = len(data)
    while i + 8 <= n:
        (ln,) = struct.unpack('>I', data[i:i + 4])
        typ = data[i + 4:i + 8]
        body = data[i + 8:i + 8 + ln]
        out.append((typ, body))
        i += 12 + ln
        if typ == b'IEND':
            break
    return out


def _unfilter(raw, width, height, bpp):
    """把滤波后的扫描线还原成原始像素"""
    stride = width * bpp
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if len(line) < stride:
            raise ValueError('PNG 数据被截断')
        if ft == 0:
            pass
        elif ft == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif ft == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ft == 3:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
        elif ft == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                c = prev[x - bpp] if x >= bpp else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xFF
        else:
            raise ValueError('未知滤波类型 %d' % ft)
        out += line
        prev = line
    return bytes(out)


# ---------------------------------------------------------------- PNG 编码
def _encode_png(pixels, width, height, bpp, color_type, bit_depth):
    """原始像素 → PNG 字节（filter 0 + zlib -9）"""
    stride = width * bpp

    def chunk(typ, body):
        return (struct.pack('>I', len(body)) + typ + body
                + struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF))

    raw = bytearray()
    for y in range(height):
        raw.append(0)                                   # filter type 0
        raw += pixels[y * stride:(y + 1) * stride]

    ihdr = struct.pack('>IIBBBBB', width, height, bit_depth,
                       color_type, 0, 0, 0)
    return (PNG_SIG + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))


def recompress_png(data):
    """PNG 无损重压，返回新字节。失败抛 ValueError"""
    cs = _chunks(data)
    ihdr = None
    idat = b''
    for typ, body in cs:
        if typ == b'IHDR':
            ihdr = body
        elif typ == b'IDAT':
            idat += body
    if ihdr is None or not idat:
        raise ValueError('PNG 缺少 IHDR 或 IDAT')

    w, h, bit_depth, color_type, _, _, _ = struct.unpack('>IIBBBBB', ihdr[:13])
    if bit_depth != 8:
        raise ValueError('只支持 8 位深，实际 %d' % bit_depth)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise ValueError('不支持的颜色类型 %d' % color_type)
    if color_type == 3:
        raise ValueError('调色板 PNG 暂不支持（避免丢色）')

    bpp = channels
    pixels = _unfilter(zlib.decompress(idat), w, h, bpp)
    return _encode_png(pixels, w, h, bpp, color_type, bit_depth)


# ---------------------------------------------------------------- 外部工具
def _which(name):
    return shutil.which(name)


def detect_tools():
    """探测本机可用的有损压缩工具"""
    found = []
    for n in ('cwebp', 'ffmpeg', 'magick', 'convert'):
        p = _which(n)
        if p:
            found.append(n)
    return found


def compress_one(path, out_path, quality, tools, ctx):
    """压缩单个文件 → {'path','ok','before','after','method','note'}"""
    ext = os.path.splitext(path)[1].lower()
    # 这里是直接 open()，没走 ctx.read_file 封装 —— 必须显式声明权限，
    # 否则"没授权 fs:read"的插件照样能读文件，权限模型就漏了
    ctx.require('fs:read')
    try:
        with open(path, 'rb') as f:
            data = f.read()
    except OSError as e:
        return {'path': path, 'ok': False, 'before': 0, 'after': 0,
                'method': '-', 'note': '读取失败: %s' % e}

    before = len(data)
    out = None
    method = '-'

    if ext == '.png':
        try:
            out = recompress_png(data)
            method = 'png:stdlib'
        except Exception as e:
            return {'path': path, 'ok': False, 'before': before, 'after': before,
                    'method': '-', 'note': 'PNG 解析失败: %s' % e}
    elif ext in ('.jpg', '.jpeg'):
        if 'ffmpeg' in tools:
            r = ctx.exec(['ffmpeg', '-y', '-loglevel', 'error', '-i', path,
                          '-q:v', str(max(1, min(31, int(31 - quality * 0.3)))),
                          out_path], timeout=120)
            if r['returncode'] == 0 and os.path.isfile(out_path):
                return {'path': path, 'ok': True, 'before': before,
                        'after': os.path.getsize(out_path),
                        'method': 'jpeg:ffmpeg', 'note': ''}
            return {'path': path, 'ok': False, 'before': before, 'after': before,
                    'method': '-', 'note': (r['stderr'] or 'ffmpeg 失败')[:200]}
        if 'magick' in tools or 'convert' in tools:
            exe = 'magick' if 'magick' in tools else 'convert'
            argv = [exe, path, '-quality', str(quality), out_path]
            if exe == 'magick':
                argv = ['magick', 'convert', path, '-quality',
                        str(quality), out_path]
            r = ctx.exec(argv, timeout=120)
            if r['returncode'] == 0 and os.path.isfile(out_path):
                return {'path': path, 'ok': True, 'before': before,
                        'after': os.path.getsize(out_path),
                        'method': 'jpeg:imagemagick', 'note': ''}
            return {'path': path, 'ok': False, 'before': before, 'after': before,
                    'method': '-', 'note': (r['stderr'] or '转换失败')[:200]}
        return {'path': path, 'ok': False, 'before': before, 'after': before,
                'method': '-',
                'note': 'JPEG 需要 ffmpeg 或 ImageMagick，本机未安装'}
    elif ext == '.webp':
        if 'cwebp' in tools:
            r = ctx.exec(['cwebp', '-q', str(quality), path, '-o', out_path],
                         timeout=120)
            if r['returncode'] == 0 and os.path.isfile(out_path):
                return {'path': path, 'ok': True, 'before': before,
                        'after': os.path.getsize(out_path),
                        'method': 'webp:cwebp', 'note': ''}
            return {'path': path, 'ok': False, 'before': before, 'after': before,
                    'method': '-', 'note': (r['stderr'] or 'cwebp 失败')[:200]}
        return {'path': path, 'ok': False, 'before': before, 'after': before,
                'method': '-', 'note': 'WebP 需要 cwebp，本机未安装'}
    else:
        return {'path': path, 'ok': False, 'before': before, 'after': before,
                'method': '-', 'note': '不支持的格式 %s' % ext}

    # PNG：只在真的变小了才写，避免"压缩"反而变大
    after = len(out)
    if after >= before:
        return {'path': path, 'ok': True, 'before': before, 'after': before,
                'method': method, 'note': '已是最优，未改动'}
    d = os.path.dirname(out_path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(out_path, 'wb') as f:
        f.write(out)
    return {'path': path, 'ok': True, 'before': before, 'after': after,
            'method': method, 'note': ''}


def _collect(inp, recursive):
    if os.path.isfile(inp):
        return [inp] if inp.lower().endswith(EXTS) else []
    out = []
    for dp, dn, fn in os.walk(inp):
        if not recursive:
            dn[:] = []
        for f in sorted(fn):
            if f.lower().endswith(EXTS):
                out.append(os.path.join(dp, f))
    return sorted(out)


def _run(ctx):
    inp = ctx.param('input')
    if not inp or not os.path.exists(inp):
        ctx.log('✗ 路径不存在：%r' % inp)
        return {'ok': False, 'error': '路径不存在'}

    ctx.list_dir(inp if os.path.isdir(inp) else os.path.dirname(inp) or '.')
    quality = int(ctx.param('quality', 82) or 82)
    quality = max(1, min(100, quality))
    outdir = ctx.param('output', '') or ''
    recursive = bool(ctx.param('recursive', True))

    files = _collect(inp, recursive)
    ctx.log('找到 %d 个图片' % len(files))
    if not files:
        return {'ok': True, 'items': [], 'saved': 0}

    tools = detect_tools()
    ctx.log('本机工具：%s' % (', '.join(tools) or '无（仅 PNG 可用）'))

    results = []
    total_before = total_after = 0
    for i, p in enumerate(files):
        ctx.progress((i + 1) / float(len(files)), os.path.basename(p))
        if outdir:
            rel = (os.path.relpath(p, inp) if os.path.isdir(inp)
                   else os.path.basename(p))
            op = os.path.join(outdir, rel)
        else:
            op = p
        r = compress_one(p, op, quality, tools, ctx)
        if r['ok']:
            total_before += r['before']
            total_after += r['after']
        else:
            total_before += r['before']
            total_after += r['before']
        results.append(r)

    saved = total_before - total_after
    pct = (saved * 100.0 / total_before) if total_before else 0.0
    ctx.log('完成：%d 个，%d → %d 字节（省 %d 字节，%.1f%%）'
            % (len(results), total_before, total_after, saved, pct))
    return {'ok': True, 'items': results, 'tools': tools,
            'before': total_before, 'after': total_after,
            'saved': saved, 'saved_pct': round(pct, 1)}


def run(ctx):
    """入口包装：把 PermissionError 转成普通失败

    ★ 插件作者不必关心权限异常 —— 未授权时直接返回 ok=False，
      而不是让异常一路抛到 UI（弹窗里看不到 traceback，等于没有提示）。
    """
    try:
        return _run(ctx)
    except PermissionError as e:
        ctx.log('✗ 权限不足：%s' % e)
        return {'ok': False, 'error': '权限不足：%s' % e, 'denied': True}
