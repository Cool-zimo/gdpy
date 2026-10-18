/* ==================================================================
   i18n-scan.js —— 英文兜底（运行时 DOM 扫描）
   ------------------------------------------------------------------
   用户原话："语言换成英文后，有一大堆没有翻译，这个功能相当于没有。"

   ★ 真实情况（先说清楚，不然会走错方向）：
     i18n.js 里 zh / en 的**键数都是 335，键是齐的**。
     问题在于界面上有 **2877 个不同的中文串是硬编码的**，根本没走 I18n.t()。
     逐个去加 data-i18n 不现实（而且每次新增文案又会漏）。

   ★ 所以这里的做法：切到英文时，遍历 DOM 的**叶子文本节点**，
     按词典做短语替换。词典没有的就保留中文 ——
     宁可留一句中文，也不能翻错（翻错比不翻更糟）。

   ★ 三条硬约束：
     1) 只处理叶子文本节点，绝不改属性、value、placeholder 以外的内容
     2) 跳过用户输入区：文件名、文件内容、代码、日志一律不动
        （把用户的文件名翻译成英文是灾难）
     3) 长短语优先匹配，否则"文件"会先把"文件名"切成两半

   ★ 翻译质量声明：这是词典匹配，不是机器翻译。
     长句可能译得不地道，但按钮、标签、状态这类短词是准的。
   ================================================================== */
(function (root) {
    'use strict';

    /* ---------------------------------------------------------------
       词典：中文 → 英文
       按"长 → 短"匹配，所以长条目必须排在前面（代码里会再排一次序，
       这里书写顺序无所谓，但保持可读）。
       --------------------------------------------------------------- */
    var DICT = {
        /* ---- 导航 / 视图 ---- */
        '仪表盘': 'Dashboard', '全部文件': 'All Files', '最近使用': 'Recent',
        '收藏': 'Favorites', '回收站': 'Trash', '我的分享': 'My Shares',
        '发现分享': 'Discover', '后台进程': 'Background Tasks', '插件广场': 'Plugins',
        '设置': 'Settings', '任务': 'Tasks', '我的文件': 'My Files',
        '使用文档': 'Documentation', '退出登录': 'Sign Out', '后端服务': 'Backend',

        /* ---- 文件操作 ---- */
        '上传文件': 'Upload Files', '上传': 'Upload', '下载': 'Download',
        '新建文件夹': 'New Folder', '重命名': 'Rename', '删除': 'Delete',
        '移动': 'Move', '复制': 'Copy', '分享': 'Share', '打开': 'Open',
        '预览': 'Preview', '刷新': 'Refresh', '搜索': 'Search',
        '全选': 'Select All', '取消全选': 'Deselect', '已选择': 'Selected',
        '拖拽文件到此处': 'Drag files here', '拖拽文件或文件夹到此处': 'Drag files or folders here',
        '选择文件': 'Choose Files', '选择文件夹': 'Choose Folder',
        '开始上传': 'Start Upload', '清空': 'Clear', '取消': 'Cancel',
        '确定': 'OK', '确认': 'Confirm', '关闭': 'Close', '返回': 'Back',
        '继续': 'Continue', '重试': 'Retry', '跳过': 'Skip', '应用': 'Apply',
        '保存': 'Save', '编辑': 'Edit', '详情': 'Details', '属性': 'Properties',

        /* ---- 状态 ---- */
        '已完成': 'Completed', '进行中': 'Running', '失败': 'Failed',
        '成功': 'Succeeded', '等待中': 'Queued', '已暂停': 'Paused',
        '已取消': 'Cancelled', '处理中': 'Processing', '加载中': 'Loading',
        '上传中': 'Uploading', '下载中': 'Downloading', '未登录': 'Not signed in',
        '已登录': 'Signed in', '未安装': 'Not installed', '检测中': 'Detecting',
        '无': 'None', '未知': 'Unknown', '暂无': 'None yet',
        '个文件': 'files', '个项目': 'items', '共': 'Total',
        '当前': 'Current', '总计': 'Total', '剩余': 'Remaining',

        /* ---- 存储 / 仓库 ---- */
        '存储仓库': 'Storage Repos', '新建存储仓库': 'New Storage Repo',
        '仓库': 'Repository', '存储用量': 'Storage Usage',
        '校准用量登记': 'Calibrate Usage', '整理合并': 'Consolidate',
        '一键优化': 'One-click Optimize', '仓库维护': 'Repo Maintenance',
        '还能写入': 'Writable', '合计': 'Total', '最大仓库': 'Largest repo',
        '分片': 'Chunk', '孤儿': 'Orphan', '孤儿分片': 'Orphan chunks',
        '私有': 'Private', '公开': 'Public', '默认': 'Default',
        '已用': 'Used', '可用': 'Available', '容量': 'Capacity',

        /* ---- 分享 ---- */
        '分享链接': 'Share Link', '复制链接': 'Copy Link', '已复制': 'Copied',
        '打开分享': 'Open Share', '查看仓库': 'View Repo', '删除分享': 'Delete Share',
        '暂无公开分享': 'No public shares yet', '创建分享': 'Create Share',
        '有效期': 'Expires', '密码': 'Password', '访问码': 'Access Code',

        /* ---- 设置 ---- */
        '外观': 'Appearance', '暗色模式': 'Dark Mode', '语言': 'Language',
        '界面自定义': 'Customize UI', '主题': 'Theme', '字号': 'Font Size',
        '行距': 'Line Height', '字距': 'Letter Spacing',
        '浅色': 'Light', '深色': 'Dark', '跟随系统': 'Follow System',
        '内容搜索': 'Content Search', '智能分类': 'Smart Categories',
        '版本切换': 'Switch Version', '导出备份': 'Export Backup',
        '帮助': 'Help', '快捷键': 'Shortcuts', '关于': 'About',
        '账号': 'Account', '添加新账号': 'Add Account', '已保存的账号': 'Saved Accounts',
        '设置项已按用途分组': 'Settings are grouped by purpose',
        '功能': 'Features', '存储与仓库': 'Storage & Repos', '关于与账号': 'About & Account',

        /* ---- 登录 ---- */
        '进入 Drive': 'Enter Drive', '没有 Token': 'No token',
        '点这里创建': 'Create one here', '个人访问令牌': 'Personal Access Token',
        '权限': 'Permission', '把 GitHub 仓库变成你的私人云盘': 'Turn GitHub repos into your private cloud drive',
        '使用 GitHub 登录': 'Sign in with GitHub', '或': 'Or',

        /* ---- 提示 ---- */
        '操作成功': 'Done', '操作失败': 'Failed', '网络错误': 'Network error',
        '请稍候': 'Please wait', '正在处理': 'Working', '稍后重试': 'Try again later',
        '确定要删除吗': 'Delete for good', '此操作不可撤销': 'This cannot be undone',
        '请求失败': 'Request failed', '权限不足': 'Permission denied',
        '文件不存在': 'File not found', '路径不存在': 'Path not found',
        '这里还没有文件': 'No files here', '暂无数据': 'No data',

        /* ---- 时间 ---- */
        '今天': 'Today', '昨天': 'Yesterday', '本周': 'This week',
        '上周': 'Last week', '本月': 'This month', '秒前': 'sec ago',
        '分钟前': 'min ago', '小时前': 'hr ago', '天前': 'days ago',

        /* ---- 后台进程 ---- */
        '收起': 'Minimize', '展开': 'Expand', '清除已结束': 'Clear finished',
        '暂停': 'Pause', '恢复': 'Resume', '后台': 'Background',
        '运行中': 'Running', '已结束': 'Finished', '全部任务': 'All tasks',

        /* ---- 通用短词（放最后，靠排序保证长词优先）---- */
        '文件': 'File', '文件夹': 'Folder', '名称': 'Name', '大小': 'Size',
        '类型': 'Type', '日期': 'Date', '时间': 'Time', '状态': 'Status',
        '说明': 'Notes', '备注': 'Notes', '描述': 'Description',
        '提示': 'Tip', '警告': 'Warning', '错误': 'Error', '信息': 'Info',
        '是': 'Yes', '否': 'No', '开': 'On', '关': 'Off',
        '启用': 'Enable', '禁用': 'Disable', '更多': 'More',
        '高级': 'Advanced', '基本': 'Basic', '其他': 'Other',

        /* ---- 补充：文件与列表 ---- */
        '文件名称': 'File Name', '文件大小': 'File Size', '文件类型': 'File Type',
        '修改时间': 'Modified', '创建时间': 'Created', '创建于': 'Created at',
        '修改于': 'Modified at', '所在路径': 'Path', '当前路径': 'Current Path',
        '上级目录': 'Parent Folder', '根目录': 'Root',
        '空文件夹': 'Empty folder', '此文件夹为空': 'This folder is empty',
        '暂无文件': 'No files', '没有文件': 'No files',
        '文件过大': 'File too large', '超过限制': 'Exceeds the limit',
        '不支持的格式': 'Unsupported format', '格式不支持': 'Unsupported format',

        /* ---- 补充：操作与确认 ---- */
        '请输入': 'Please enter', '请选择': 'Please select', '必填': 'Required',
        '不能为空': 'Cannot be empty', '已存在': 'Already exists',
        '名称重复': 'Name already exists', '无效': 'Invalid',
        '已删除': 'Deleted', '已移动': 'Moved', '已复制': 'Copied',
        '已重命名': 'Renamed', '已创建': 'Created', '已保存': 'Saved',
        '已更新': 'Updated', '已上传': 'Uploaded', '已下载': 'Downloaded',
        '移入回收站': 'Move to Trash', '彻底删除': 'Delete permanently',
        '恢复': 'Restore', '还原': 'Restore', '清空回收站': 'Empty Trash',
        '下载全部': 'Download all', '批量操作': 'Bulk actions',
        '右键菜单': 'Context menu', '更多操作': 'More actions',

        /* ---- 补充：上传/下载 ---- */
        '上传进度': 'Upload progress', '下载进度': 'Download progress',
        '上传完成': 'Upload complete', '下载完成': 'Download complete',
        '上传失败': 'Upload failed', '下载失败': 'Download failed',
        '正在上传': 'Uploading', '正在下载': 'Downloading',
        '剩余时间': 'Time left', '传输速度': 'Speed',
        '断点续传': 'Resume', '暂停上传': 'Pause upload',
        '选择要上传的文件': 'Choose files to upload',

        /* ---- 补充：分享 ---- */
        '创建分享链接': 'Create share link', '分享设置': 'Share settings',
        '复制链接成功': 'Link copied', '复制失败': 'Copy failed',
        '公开分享': 'Public share', '私密分享': 'Private share',
        '访问次数': 'Views', '下载次数': 'Downloads',
        '过期时间': 'Expiry', '永久有效': 'Never expires',
        '取消分享': 'Remove share',

        /* ---- 补充：仓库与存储 ---- */
        '存储仓库管理': 'Storage Repos', '仓库列表': 'Repo list',
        '新建仓库': 'New Repo', '删除仓库': 'Delete Repo',
        '切换仓库': 'Switch Repo', '仓库信息': 'Repo info',
        '已使用': 'Used', '剩余空间': 'Free space',
        '总计容量': 'Total capacity', '占用': 'Used',
        '自动整理': 'Auto-consolidate', '自动整理设置': 'Auto-consolidate',
        '整理方案': 'Consolidation plan', '迁移': 'Migrate',
        '腾空的仓': 'Emptied repo', '删除腾空的仓': 'Delete emptied repos',

        /* ---- 补充：后台进程 ---- */
        '任务列表': 'Task list', '任务详情': 'Task details',
        '开始时间': 'Started', '结束时间': 'Finished',
        '运行时长': 'Duration', '进度': 'Progress',
        '子任务': 'Subtasks', '错误信息': 'Error',
        '失败原因': 'Failure reason', '重试该任务': 'Retry task',
        '清除记录': 'Clear records', '暂无任务': 'No tasks',
        '全部清除': 'Clear all',

        /* ---- 补充：设置项 ---- */
        '自动整理开关': 'Auto-consolidate', '单次迁移上限': 'Max migration',
        '冷却时间': 'Cooldown', '上次整理': 'Last consolidation',
        '实验功能': 'Experimental', '开发者选项': 'Developer options',
        '清除缓存': 'Clear cache', '重置设置': 'Reset settings',
        '导入配置': 'Import', '导出配置': 'Export',
        '切换账号': 'Switch account', '注销': 'Sign out',

        /* ---- 补充：提示与错误 ---- */
        '网络连接失败': 'Network connection failed',
        '请求超时': 'Request timed out', '服务器错误': 'Server error',
        '认证失败': 'Authentication failed', '令牌无效': 'Invalid token',
        '令牌已过期': 'Token expired', '权限不足，请检查令牌': 'Insufficient permission',
        '操作被取消': 'Cancelled', '未知错误': 'Unknown error',
        '请刷新页面': 'Please refresh the page',
        '正在加载': 'Loading', '加载失败': 'Load failed',
        '保存成功': 'Saved', '保存失败': 'Save failed',
        '删除成功': 'Deleted', '删除失败': 'Delete failed',
        '操作已完成': 'Done',

        /* ---- 补充：通用 ---- */
        '全部': 'All', '仅': 'Only', '不限': 'Any',
        '升序': 'Ascending', '降序': 'Descending', '排序': 'Sort',
        '按名称': 'By name', '按大小': 'By size', '按时间': 'By date',
        '网格视图': 'Grid view', '列表视图': 'List view',
        '图标': 'Icon', '缩略图': 'Thumbnail',
        '显示': 'Show', '隐藏': 'Hide', '折叠': 'Collapse',
        '展开全部': 'Expand all', '收起全部': 'Collapse all',
        '上移': 'Move up', '下移': 'Move down',
        '宽度': 'Width', '高度': 'Height', '顺序': 'Order',
        '恢复默认': 'Reset to default', '应用设置': 'Apply',
        '确认删除': 'Confirm delete', '危险操作': 'Dangerous',
        '不可逆': 'Irreversible',
        '正在检查': 'Checking', '检查完成': 'Check complete',
        '发现问题': 'Issues found', '一切正常': 'All good',
        '修复': 'Fix', '一键修复': 'One-click fix',
        '扫描': 'Scan', '扫描中': 'Scanning',

        /* ---- 补充：设置页正文（这些是硬编码长句，词典里没有就整句留中文，
                 是"换英文后一大堆没翻译"的重灾区）---- */
        '切换深色/浅色主题': 'Switch between dark and light theme',
        '界面自定义': 'Customize UI',
        '侧边栏/顶栏右键可勾选显示项，这里调主题与字号': 'Right-click the sidebar or top bar to toggle items; themes and font size are here',
        '仓鼠联动': 'Cangshu Link',
        '默认关闭 · 打开后登录页才会出现「沿用仓鼠账号」': 'Off by default · when on, the login page offers "Use Cangshu account"',
        '逐仓用量、新建仓库、校准容量登记、整理合并': 'Per-repo usage, create repos, calibrate usage, consolidate',
        '后台自动填满仓库、删除腾空的仓': 'Auto-fill repos in the background and delete emptied ones',
        '按文件类型自动整理到文件夹': 'Sort files into folders by type',
        '查看快捷键和使用提示': 'View shortcuts and usage tips',
        '体验他人改进的版本': 'Try builds improved by others',
        '导出所有配置为 JSON 文件': 'Export all settings as a JSON file',
        '清除 Token 返回登录页': 'Clear the token and return to login',
        '内容搜索已开启：搜索时也会匹配文本文件内容（更慢）': 'Content search on: also matches text file contents (slower)',
        '内容搜索已关闭：只匹配文件名': 'Content search off: matches file names only',
        '满足条件时后台自动执行': 'Runs in the background when conditions are met',
        '自动删除腾空的仓': 'Auto-delete emptied repos',
        '会删除': 'Will delete',
        '保留': 'Keep',
        '手动触发': 'Run now',
        '贴边显示': 'Dock to edge',
        '它们都跑这儿来了': 'They all ended up here',
        '已开启仓鼠联动，刷新登录页后生效': 'Cangshu link is on — refresh the login page to apply',
        '已关闭仓鼠联动': 'Cangshu link is off',

        /* ---- 补充：存储与仓库 ---- */
        '存储满了': 'Storage full',
        '容量已满': 'Capacity full',
        '校准用量': 'Calibrate usage',
        '切分阈值': 'Split threshold',
        '存储仓库管理': 'Storage Repos',
        '存储用量统计': 'Storage Usage',
        '创建存储仓库': 'Create storage repo',
        '仓库描述': 'Repo description',
        '已拆分存储': 'Split across repos',
        '获取仓库体积失败': 'Failed to get repo size',
        '仓库满了传不进去': 'Repo is full, upload rejected',
        '将永久删除': 'will be permanently deleted',
        '个孤儿分片，释放': 'orphan chunks, freeing',
        '无需清理': 'Nothing to clean',
        '选仓库和': 'Pick a repo and',
        '校准用量登记': 'Calibrate usage',

        /* ---- 补充：账号 ---- */
        '移除账号': 'Remove account',
        '确定要移除这个账号吗？': 'Remove this account?',
        '请输入 Token': 'Please enter your token',
        '项已选': 'selected',
        '开始下载': 'Start download',
        '确定删除选中的': 'Delete the selected',
        '个文件吗？': 'files?',
        '移动到…': 'Move to…',
        '复制到…': 'Copy to…',
        '编辑文件': 'Edit file',
        '标签管理': 'Manage tags',
        '版本历史': 'Version history',
        '取消收藏': 'Remove from favorites',
        '文件夹导航': 'Folder tree',
        '高级筛选': 'Advanced filter',
        '留空则不过滤': 'Leave empty to skip filtering',
        '没有匹配的文件': 'No matching files',
        '输入文件夹名称': 'Enter a folder name',
        '在线编辑器': 'Online editor',
        '扫描中…': 'Scanning…',
        '重新扫描': 'Rescan',
        '确认请输入数字': 'Please enter a number',
        '数据还没加载完': 'Data is still loading',
        '没有成功复制任何文件': 'No files were copied',
        '只增不删，不会覆盖现有文件。继续？': 'Add-only: existing files are never overwritten. Continue?',
        '跳过（已存在）': 'Skipped (already exists)',
        '忽略（隐藏文件/空名）': 'Ignored (hidden file / empty name)',
        '已跳过（同名）': 'Skipped (same name)',
        '已跳过': 'Skipped',
        '恢复到 _recovered': 'Restore to _recovered',

        /* ---- 补充：后端服务 ---- */
        '后端服务管理': 'Backend Service',
        '后端服务设置': 'Backend Settings',
        '未知（旧版后端）': 'Unknown (legacy backend)',
        '加速源': 'Mirror',
        '下载后端服务': 'Downloading backend',
        '服务异常': 'Service error',
        '无法连接': 'Cannot connect',
        '检查更新失败': 'Failed to check for updates',
        '已切换到暗色模式': 'Switched to dark mode',
        '已切换到浅色模式': 'Switched to light mode',

        /* ---- 补充：插件 ---- */
        '插件在移动端不可用（无法下载插件后端）': 'Plugins are unavailable on mobile (backend cannot be downloaded)',
        '正在安装': 'Installing',
        '安装成功': 'Installed',
        '安装失败': 'Install failed',
        '收起到侧边': 'Minimize to sidebar',
        '收进后台进程': 'Send to background',
        '运行中的插件': 'Running plugins',
        '下载不了插件后端': 'Cannot download the plugin backend',

        /* ---- 补充：版本广场 ---- */
        '官方版 (main)': 'Official (main)',
        '搜索版本 / 作者': 'Search version / author',
        '版本广场': 'Version Hub',
        '没有匹配的版本': 'No matching version',
        '已经是当前版本了': 'Already on this version',
        '正在检测「': 'Checking 「',
        '」能否加载…': '」 can be loaded…',
        '已切换到': 'Switched to',
        '，正在刷新…': ', reloading…',

        /* ---- 补充：失败提示（带冒号前缀的一律照翻，别让整句留中文）---- */
        '删除失败': 'Delete failed',
        '上传失败': 'Upload failed',
        '下载失败': 'Download failed',
        '恢复失败': 'Restore failed',
        '移动失败': 'Move failed',
        '创建失败': 'Create failed',
        '未知错误': 'Unknown error',
        '搜索时同时匹配文件内容': 'Also match file contents when searching',
        '内容': 'Contents',
        '匹配': 'Match',
        '同时': 'Also',
        '已开启': 'On',
        '已关闭': 'Off'
    };

    /* 长键优先：否则"文件"会先把"文件名"切碎 */
    var KEYS = Object.keys(DICT).sort(function (a, b) { return b.length - a.length; });

    /* 这些容器里的内容是用户数据，绝不翻译 */
    function isProtected(el) {
        if (!el) return true;
        var t = el.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'CODE' || t === 'PRE' ||
            t === 'TEXTAREA' || t === 'NOSCRIPT') return true;
        // ★ 必须从 el 自己开始查，不能从 parentElement 开始 ——
        //   否则 <div class="file-name">文本</div> 这种，
        //   文本节点的父元素就是它自己，从 parent 起步会直接跳过，
        //   文件名照样被翻掉（实测抓到）。
        var p = el;
        while (p && p !== document.body) {
            var c = typeof p.className === 'string' ? p.className : '';
            if (/gd-code|terminal|log-box|bm-logs|hljs|file-name|breadcrumb-path/.test(c)) return true;
            var pt = p.tagName;
            if (pt === 'CODE' || pt === 'PRE') return true;
            p = p.parentElement;
        }
        return false;
    }

    function hasCJK(s) { return /[\u4e00-\u9fa5]/.test(s); }

    function translate(s) {
        var out = s, hit = false;
        for (var i = 0; i < KEYS.length; i++) {
            if (out.indexOf(KEYS[i]) >= 0) {
                out = out.split(KEYS[i]).join(DICT[KEYS[i]]);
                hit = true;
            }
        }
        return hit ? out : null;
    }

    var _on = false;

    function walk(scope) {
        var tw = document.createTreeWalker(
            scope || document.body,
            root.NodeFilter ? root.NodeFilter.SHOW_TEXT : 4,
            null, false
        );
        var n, list = [];
        while ((n = tw.nextNode())) list.push(n);      // 先收集，避免边改边遍历
        for (var i = 0; i < list.length; i++) {
            var node = list[i];
            var v = node.nodeValue;
            if (!v || !hasCJK(v)) continue;
            if (isProtected(node.parentElement)) continue;
            // 已经译过的别再译
            if (node.__gdEn && node.__gdEn === v) continue;
            var t = translate(v);
            if (t === null) continue;
            node.__gdSrc = node.__gdSrc || v;
            node.nodeValue = t;
            node.__gdEn = t;
        }
    }

    /* ---------------------------------------------------------------
       裸键清洗：界面上露出 "settings.groupedHint" 这种原始 i18n 键名，
       是 I18n.t() 找不到键时原样返回造成的。
       判据很严：只有「纯 ASCII 点分串」且「确实能在词典里查到这个键」
       才认定它是漏翻的键 —— 文件名 app.js、域名 example.com、
       版本号 v0.0.76 都查不到，因此绝不会被误伤。
       --------------------------------------------------------------- */
    function cleanBareKeys(scope) {
        if (!root.I18n || !root.I18n.translations) return;
        var cur = (root.I18n.current || '').toLowerCase().indexOf('en') === 0;
        var en = root.I18n.translations['en'] || {};
        var zh = root.I18n.translations['zh-CN'] || {};
        var tw = document.createTreeWalker(
            scope || document.body,
            root.NodeFilter ? root.NodeFilter.SHOW_TEXT : 4, null, false
        );
        var n, list = [];
        while ((n = tw.nextNode())) list.push(n);
        for (var i = 0; i < list.length; i++) {
            var node = list[i];
            var v = (node.nodeValue || '').trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(v)) continue;
            if (isProtected(node.parentElement)) continue;
            var repl = cur ? (en[v] || zh[v]) : (zh[v] || en[v]);
            if (repl == null || repl === '') continue;
            if (node.__gdSrc == null) node.__gdSrc = node.nodeValue;
            node.nodeValue = repl;
            node.__gdEn = repl;
        }
    }

    function apply() {
        cleanBareKeys(document.body);
        if (!_on) return;
        walk(document.body);
        // 常见动态区再单独走一遍（它们是 innerHTML 重渲染的）
        var ids = ['file-list', 'task-list', 'settings-view', 'login-screen'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) { cleanBareKeys(el); walk(el); }
        }
    }

    /* 还原：切回中文时把原文放回去 */
    function revert() {
        var tw = document.createTreeWalker(
            document.body,
            root.NodeFilter ? root.NodeFilter.SHOW_TEXT : 4, null, false
        );
        var n, list = [];
        while ((n = tw.nextNode())) list.push(n);
        for (var i = 0; i < list.length; i++) {
            if (list[i].__gdSrc != null) {
                list[i].nodeValue = list[i].__gdSrc;
                list[i].__gdEn = null;
            }
        }
    }

    var mo = null, timer = null;
    function observe() {
        if (mo || !root.MutationObserver) return;
        mo = new root.MutationObserver(function () {
            if (!_on) return;
            clearTimeout(timer);
            timer = setTimeout(apply, 80);
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    var api = {
        setEnabled: function (on) {
            _on = !!on;
            if (_on) { apply(); observe(); }
            else { revert(); }
        },
        apply: apply,
        revert: revert,
        size: function () { return KEYS.length; }
    };

    root.GdI18nScan = api;

    /* 跟随 I18n.toggle()：它在切中英文，我们跟着开/关 */
    function hook() {
        if (root.I18n && root.I18n.toggle && !root.I18n.__gdScanHooked) {
            var orig = root.I18n.toggle.bind(root.I18n);
            root.I18n.toggle = function () {
                var r = orig();
                var en = (root.I18n.current || '').toLowerCase().indexOf('en') === 0;
                setTimeout(function () { api.setEnabled(en); }, 30);
                return r;
            };
            root.I18n.__gdScanHooked = true;
        }
    }

    function init() {
        hook();
        var cur = (root.I18n && root.I18n.current) || '';
        if (cur.toLowerCase().indexOf('en') === 0) { _on = true; apply(); observe(); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init(); setTimeout(function () { hook(); init(); }, 300);
        });
    } else {
        init(); setTimeout(function () { hook(); init(); }, 300);
    }
})(typeof window !== 'undefined' ? window : this);
