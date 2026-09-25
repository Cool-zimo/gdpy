/**
 * UI 模块
 * 负责界面渲染、交互事件、模态框、通知等
 */
class UI {
    constructor(app) {
        this.app = app;
        this.selectedFile = null;
        this.selectedFiles = [];
        this._multiSelectMode = false;
        this.contextMenuTarget = null;
        this.searchTimeout = null;
        // 先绑定登录相关事件（确保即使后续初始化失败，登录也能用）
        this.bindLoginEvents();
        // 其他事件绑定用 try-catch 包裹，避免单个元素问题导致整体失败
        try {
            this.bindEvents();
        } catch (e) {
            console.error('UI 部分事件绑定失败:', e);
        }
    }

    /**
     * 绑定登录相关事件（优先绑定，不依赖其他元素）
     */
    bindLoginEvents() {
        const loginBtn =
            document.getElementById('enter-drive-btn') ||
            document.getElementById('login-btn');
        const tokenInput = document.getElementById('token-input');
        const loginForm = document.getElementById('login-form');

        const handleLogin = (e) => {
            e?.preventDefault();

            const token = tokenInput?.value?.trim() || '';

            // 没有 Token 时先进入登录界面
            if (!token) {
                this.app.showLogin();
                tokenInput?.focus();
                return;
            }

            this.app.login(token);
        };

        if (loginBtn) {
            loginBtn.type = 'button';
            loginBtn.addEventListener('click', handleLogin);
            console.log('[GitHub Drive] 进入 Drive 按钮事件已绑定');
        } else {
            console.error('[GitHub Drive] 未找到进入 Drive/登录按钮');
        }

        loginForm?.addEventListener('submit', handleLogin);

        if (tokenInput) {
            tokenInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleLogin(e);
            });
        }

        console.log('[GitHub Drive] 登录事件绑定完成');
    }

    init() {
        this.bindEvents();
        this.initSidebarResizer();
    }
    
    // 侧边栏宽度拖拽调整
    initSidebarResizer() {
        const resizer = document.getElementById('sidebar-resizer');
        if (!resizer) return;
        
        // 从 localStorage 恢复宽度
        const savedWidth = localStorage.getItem('gd_sidebar_width');
        if (savedWidth) {
            const w = parseInt(savedWidth);
            if (w >= 180 && w <= 400) {
                document.documentElement.style.setProperty('--sidebar-width', w + 'px');
            }
        }
        
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;
        
        resizer.addEventListener('mousedown', (e) => {
            // 移动端不启用
            if (window.innerWidth < 768) return;
            
            isResizing = true;
            startX = e.clientX;
            startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 260;
            resizer.classList.add('dragging');
            document.body.classList.add('resizing');
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newWidth = startWidth + (e.clientX - startX);
            const clampedWidth = Math.max(180, Math.min(400, newWidth));
            document.documentElement.style.setProperty('--sidebar-width', clampedWidth + 'px');
        });
        
        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            resizer.classList.remove('dragging');
            document.body.classList.remove('resizing');
            const currentWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
            localStorage.setItem('gd_sidebar_width', currentWidth);
        });
    }

    // ==================== 事件绑定 ====================

    bindEvents() {
        // 登录事件已在 bindLoginEvents 中绑定

        // 退出登录
        document.getElementById('logout-btn')?.addEventListener('click', () => this.app.logout());
        document.getElementById('backend-btn')?.addEventListener('click', () => this.showBackendManager());

        // 导航
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchView(item.dataset.view);
            });
        });

        // 工具栏按钮
        document.getElementById('upload-btn').addEventListener('click', () => this.openUploadModal());
        // 上传弹窗文件选择
        document.getElementById('upload-file-input')?.addEventListener('change', (e) => this.addUploadFiles(Array.from(e.target.files)));
        document.getElementById('upload-folder-input')?.addEventListener('change', (e) => this.addUploadFiles(Array.from(e.target.files)));
        // 上传弹窗拖拽
        const dropZone = document.getElementById('upload-drop-zone');
        if (dropZone) {
            dropZone.addEventListener('click', () => document.getElementById('upload-file-input').click());
            dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
            dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
            dropZone.addEventListener('drop', async (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                const files = [];
                if (e.dataTransfer.items) {
                    for (const item of e.dataTransfer.items) {
                        if (item.kind === 'file') {
                            const entry = item.webkitGetAsEntry?.();
                            if (entry && entry.isDirectory) {
                                // 文件夹：递归读取
                                const dirFiles = await this.readDirectoryEntry(entry);
                                files.push(...dirFiles);
                            } else {
                                files.push(item.getAsFile());
                            }
                        }
                    }
                } else {
                    files.push(...Array.from(e.dataTransfer.files));
                }
                this.addUploadFiles(files.filter(Boolean));
            });
        }
        document.getElementById('view-toggle-btn')?.addEventListener('click', () => this.toggleView());
        document.getElementById('folder-tree-btn')?.addEventListener('click', () => this.showFolderTree());
        document.getElementById('new-folder-btn').addEventListener('click', () => this.showNewFolderModal());
        // document.getElementById('create-repo-btn')?.addEventListener('click', () => this.showCreateRepoModal());
        // document.getElementById('add-repo-btn')?.addEventListener('click', () => this.showLinkRepoModal());

        // 文件输入
        document.getElementById('file-input').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.app.uploadFiles(Array.from(e.target.files));
                e.target.value = '';
            }
        });
        document.getElementById('folder-input')?.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.app.uploadFolder(Array.from(e.target.files));
                e.target.value = '';
            }
        });

        // 搜索
        document.getElementById('adv-search-btn')?.addEventListener('click', () => this.showAdvancedSearch());
        document.getElementById('search-input').addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.app.searchFiles(e.target.value);
            }, 300);
        });

        // 拖拽上传
        this.setupDragAndDrop();

        // 应用视图偏好
        this.applyViewPreference();

        // 移动端汉堡菜单
        const menuToggle = document.getElementById('menu-toggle');
        const sidebar = document.querySelector('.sidebar');
        const sidebarOverlay = document.getElementById('sidebar-overlay');
        const mainContent = document.querySelector('.main-content');
        if (menuToggle && sidebar && sidebarOverlay) {
            const isMobile = () => window.innerWidth <= 768;
            const toggleSidebar = (open) => {
                if (isMobile()) {
                    // 移动端：弹出/隐藏侧边栏
                    const shouldOpen = open !== undefined ? open : !sidebar.classList.contains('open');
                    sidebar.classList.toggle('open', shouldOpen);
                    sidebarOverlay.classList.toggle('active', shouldOpen);
                } else {
                    // 电脑端：折叠/展开侧边栏
                    const isCollapsed = sidebar.classList.contains('collapsed');
                    sidebar.classList.toggle('collapsed', !isCollapsed);
                    if (mainContent) mainContent.classList.toggle('sidebar-collapsed', !isCollapsed);
                    // 保存状态
                    localStorage.setItem('gd_sidebar_collapsed', !isCollapsed);
                }
            };
            menuToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSidebar(); });
            sidebarOverlay.addEventListener('click', () => toggleSidebar(false));
            document.querySelectorAll('.sidebar .nav-item').forEach(item => {
                item.addEventListener('click', () => { if (isMobile()) toggleSidebar(false); });
            });
            
            // 恢复电脑端折叠状态
            if (!isMobile() && localStorage.getItem('gd_sidebar_collapsed') === 'true') {
                sidebar.classList.add('collapsed');
                if (mainContent) mainContent.classList.add('sidebar-collapsed');
            }
        }

        // 右键菜单
        document.addEventListener('click', () => this.hideContextMenu());
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.file-item')) {
                this.hideContextMenu();
            }
        });

        // 模态框关闭
        document.getElementById('modal-container').addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay')) {
                this.closeModal();
            }
        });

        // 键盘快捷键
        document.addEventListener('keydown', (e) => {
            // 忽略输入框中的快捷键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
                return;
            }
            if (e.key === 'Escape') {
                this.closeModal();
                this.hideContextMenu();
                this.exitMultiSelectMode();
            }
            // Ctrl+A 全选
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                this.selectAllFiles();
            }
            // Delete 删除选中文件
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedFiles && this.selectedFiles.length > 0) {
                    e.preventDefault();
                    this.app.deleteFiles(this.selectedFiles);
                }
            }
            // F2 重命名
            if (e.key === 'F2' && this.selectedFiles && this.selectedFiles.length === 1) {
                e.preventDefault();
                this.showRenameModal(this.selectedFiles[0]);
            }
            // / 聚焦搜索
            if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                document.getElementById('search-input')?.focus();
            }
            // Ctrl+D 收藏/取消收藏
            if ((e.ctrlKey || e.metaKey) && e.key === 'd' && this.selectedFiles && this.selectedFiles.length === 1) {
                e.preventDefault();
                this.app.toggleStar(this.selectedFiles[0]);
            }
        });
    }

    // ==================== 视图切换 ====================

    switchView(view) {
        this.app._currentView = view;
        this.app.saveLastState?.();
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

        // 清除仓库选中状态
        document.querySelectorAll('.repo-item').forEach(item => item.classList.remove('active'));

        const breadcrumb = document.getElementById('breadcrumb');
        const toolbarActions = document.querySelector('.toolbar-actions');
        const fileList = document.getElementById('file-list');
        const emptyState = document.getElementById('empty-state');
        const loadingState = document.getElementById('loading-state');

        if (view === 'all-files') {
            // 恢复文件浏览器界面
            if (breadcrumb) breadcrumb.style.display = '';
            if (toolbarActions) toolbarActions.style.display = '';
            if (fileList) fileList.style.display = '';
            // 恢复之前的路径（不保持回收站路径）
            const savedState = this.app.storage.get('last_state', null);
            const savedPath = savedState?.path || '/drive_home';
            if (savedPath && !savedPath.includes('.trash')) {
                this.app.fileManager.setCurrentPath(savedPath);
            } else {
                this.app.fileManager.setCurrentPath('/drive_home');
            }
            this.app.fileManager.setCurrentRepo(null);
            this.app.loadFiles();
        } else if (view === 'dashboard') {
            // 仪表盘视图：隐藏面包屑和工具栏，但显示文件区域
            if (breadcrumb) breadcrumb.style.display = 'none';
            if (toolbarActions) toolbarActions.style.display = 'none';
            if (fileList) fileList.style.display = '';
            if (emptyState) emptyState.classList.add('hidden');
            if (loadingState) loadingState.classList.add('hidden');
            this.app.showDashboard();
        } else {
            // 非文件视图：隐藏面包屑、工具栏和文件区域
            if (breadcrumb) breadcrumb.style.display = 'none';
            if (toolbarActions) toolbarActions.style.display = 'none';
            if (fileList) fileList.style.display = 'none';
            if (emptyState) emptyState.classList.add('hidden');
            if (loadingState) loadingState.classList.add('hidden');
            
            if (view === 'recent') {
                this.app.showRecentFiles();
            } else if (view === 'starred') {
                this.app.showStarredFiles();
            } else if (view === 'trash') {
                this.app.showTrashFiles();
            } else if (view === 'shared') {
                this.app.showShares();
            } else if (view === 'explore') {
                this.app.showExploreShares();
            } else if (view === 'plugins') {
                this.app.showPluginMarket();
            }
        }
    }

    // ==================== 渲染 ====================

    /**
     * 渲染用户信息
     */
    renderUserInfo(user) {
        const el = document.getElementById('user-info');
        el.innerHTML = `
            <img src="${user.avatar_url}" alt="${user.login}">
            <div>
                <div class="user-name">${user.name || user.login}</div>
                <div class="user-login">@${user.login} ▾</div>
            </div>
        `;
    }
    
    // 渲染登录页的已保存账号列表
    renderSavedAccounts() {
        const accounts = this.app.storage.getAccounts();
        const container = document.getElementById('saved-accounts');
        const list = document.getElementById('accounts-list');
        if (!container || !list) return;
        
        if (accounts.length === 0) {
            container.style.display = 'none';
            return;
        }
        
        container.style.display = 'block';
        list.innerHTML = accounts.map(acc => `
            <div class="account-item" onclick="app.login('${acc.token}')">
                <img src="${acc.user?.avatar_url || ''}" alt="${acc.user?.login || ''}" class="account-avatar">
                <div class="account-info">
                    <div class="account-name">${acc.user?.name || acc.user?.login || 'Unknown'}</div>
                    <div class="account-login">@${acc.user?.login || ''}</div>
                </div>
                <button class="account-remove" onclick="event.stopPropagation();ui.removeAccount('${acc.id}')" title="移除账号">×</button>
            </div>
        `).join('');
    }
    
    // 显示账号切换弹窗
    showAccountSwitcher() {
        const accounts = this.app.storage.getAccounts();
        const currentId = this.app.storage.getCurrentAccountId();
        
        let body = '<div style="padding:8px 0;">';
        // 添加新账号按钮
        body += `
            <div onclick="ui.showAddAccount()" style="display:flex;align-items:center;gap:12px;padding:12px;border:2px dashed #d1d5db;border-radius:10px;cursor:pointer;margin-bottom:12px;transition:all 0.2s;" onmouseover="this.style.borderColor='#3b82f6';this.style.background='#eff6ff'" onmouseout="this.style.borderColor='#d1d5db';this.style.background='transparent'">
                <span style="font-size:24px;color:#3b82f6;">+</span>
                <div><div style="font-weight:600;font-size:14px;color:#3b82f6;"><span data-i18n="login.addAccount">添加新账号</span></div>
                <div style="font-size:12px;color:#6b7280;">输入 Token 登录新账号</div></div>
            </div>
        `;
        accounts.forEach(acc => {
            const isCurrent = acc.id === currentId;
            body += `
                <div class="account-item ${isCurrent ? 'account-current' : ''}" onclick="${isCurrent ? '' : `app.switchAccount('${acc.id}')`}" style="${isCurrent ? 'opacity:0.6;cursor:default;' : ''}">
                    <img src="${acc.user?.avatar_url || ''}" alt="" class="account-avatar">
                    <div class="account-info">
                        <div class="account-name">${acc.user?.name || acc.user?.login || 'Unknown'} ${isCurrent ? '<span style="font-size:11px;color:#16a34a;">(当前)</span>' : ''}</div>
                        <div class="account-login">@${acc.user?.login || ''}</div>
                    </div>
                    ${isCurrent ? '' : `<button class="account-remove" onclick="event.stopPropagation();ui.removeAccount('${acc.id}')" title="移除账号">×</button>`}
                </div>
            `;
        });
        body += '</div>';
        body += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb;">
            <button class="btn-secondary" style="width:100%;" onclick="ui.closeModal();app.logout();">
                <span data-i18n="settings.logout">退出登录</span>
            </button>
        </div>`;
        
        this.showModal(I18n.t('login.savedAccounts') || '切换账号', body, '', true);
    }
    
    // 显示添加新账号弹窗
    showAddAccount() {
        const body = `
            <div style="padding:8px 0;">
                <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px;">GitHub Personal Access Token</label>
                <input type="password" id="add-account-token" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:8px;">
                <p style="font-size:12px;color:#6b7280;margin:0 0 12px;">需要 repo 和 workflow 权限</p>
                <button class="btn-primary" onclick="ui.submitAddAccount()" style="width:100%;"><span data-i18n="login.enter">进入 Drive</span></button>
            </div>
        `;
        this.showModal(I18n.t('login.addAccount') || '添加新账号', body, '', true);
    }
    
    // 提交添加新账号
    async submitAddAccount() {
        const token = document.getElementById('add-account-token').value.trim();
        if (!token) {
            this.showToast('请输入 Token', 'error');
            return;
        }
        this.closeModal();
        await this.app.login(token);
    }
    
    // 移除账号
    removeAccount(accountId) {
        if (confirm(I18n.t('settings.logoutConfirm') || '确定要移除这个账号吗？')) {
            this.app.removeAccount(accountId);
            this.renderSavedAccounts();
            this.closeModal();
        }
    }

    /**
     * 渲染仓库列表
     */
    renderRepoList() {
        const repos = this.app.storage.getRepos();
        const container = document.getElementById('repo-list');
        const config = this.app.storage.getStorageConfig();
        container.innerHTML = repos.map(repo => {
            const used = this.app.storage.getRepoUsageSize(repo.owner, repo.repo);
            const percent = this.app.storage.getRepoUsagePercent(repo.owner, repo.repo);
            const remaining = this.app.storage.getRepoRemaining(repo.owner, repo.repo);
            const isWarning = percent >= config.warnThreshold;
            const isFull = percent >= 0.95;
            const barColor = isFull ? '#cf222e' : (isWarning ? '#9a6700' : '#0969da');
            return `
            <div class="repo-item ${this.app.fileManager.currentRepo?.repo === repo.repo ? 'active' : ''}"
                 data-owner="${repo.owner}" data-repo="${repo.repo}" style="flex-direction:column;align-items:stretch;gap:4px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="repo-icon">${isFull ? '🔴' : (isWarning ? '🟡' : '📦')}</span>
                    <span class="repo-name" title="${repo.name}" style="flex:1;">${repo.name}</span>
                    ${repo.isDefault ? '<span class="repo-badge">默认</span>' : ''}
                </div>
                <div style="display:flex;align-items:center;gap:6px;padding-left:22px;">
                    <div style="flex:1;height:4px;background:#eaeef2;border-radius:2px;overflow:hidden;">
                        <div style="height:100%;width:${Math.round(percent * 100)}%;background:${barColor};border-radius:2px;transition:width 0.3s;"></div>
                    </div>
                    <span style="font-size:10px;color:#8c959f;white-space:nowrap;">${Storage.formatBytes(used)}/${Storage.formatBytes(config.maxRepoSize)}</span>
                </div>
                ${isWarning ? `<div style="font-size:10px;color:${isFull ? '#cf222e' : '#9a6700'};padding-left:22px;">${isFull ? '容量已满' : '剩余 ' + Storage.formatBytes(remaining)}</div>` : ''}
            </div>
        `}).join('');

        // 绑定点击事件
        container.querySelectorAll('.repo-item').forEach(item => {
            item.addEventListener('click', () => {
                const owner = item.dataset.owner;
                const repoName = item.dataset.repo;
                const repoInfo = this.app.storage.findRepo(owner, repoName);
                if (repoInfo) {
                    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                    this.app.fileManager.setCurrentRepo(repoInfo);
                    this.renderRepoList();
                    this.app.loadFiles();
                }
            });
        });
    }

    /**
     * 渲染面包屑
     */
    renderBreadcrumb() {
        const crumbs = this.app.fileManager.getBreadcrumb();
        const container = document.getElementById('breadcrumb');
        container.innerHTML = crumbs.map((crumb, i) => {
            const isLast = i === crumbs.length - 1;
            return `
                <span class="breadcrumb-item ${isLast ? 'current' : ''}" data-path="${crumb.path}">
                    ${crumb.isRepo ? '📦 ' : ''}${crumb.name}
                </span>
                ${!isLast ? '<span class="breadcrumb-separator">/</span>' : ''}
            `;
        }).join('');

        // 绑定点击和拖放
        container.querySelectorAll('.breadcrumb-item').forEach(item => {
            item.addEventListener('click', () => {
                this.app.fileManager.setCurrentPath(item.dataset.path);
                this.app.loadFiles();
            });
            // 支持拖放文件到面包屑（移动到上级文件夹）
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.add('drop-target');
            });
            item.addEventListener('dragleave', (e) => {
                e.stopPropagation();
                item.classList.remove('drop-target');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove('drop-target');
                document.getElementById('drop-overlay')?.classList.add('hidden');
                const dragged = this._draggedFile;
                if (dragged) {
                    this.app.moveFileByDrag(dragged, item.dataset.path);
                }
            });
        });
    }

    /**
     * 渲染文件列表
     */
    renderFileList(files) {
        const container = document.getElementById('file-list');
        const emptyState = document.getElementById('empty-state');
        const loadingState = document.getElementById('loading-state');

        loadingState?.classList.add('hidden');

        if (files.length === 0) {
            container.innerHTML = '';
            emptyState?.classList.remove('hidden');
            return;
        }

        emptyState?.classList.add('hidden');
        container.innerHTML = files.map((file, index) => {
            const type = file.isFolder ? 'dir' : 'file';
            const icon = FileManager.getFileIcon(file.name, type);
            const size = file.isFolder ? '' : FileManager.formatSize(file.size);
            const chunkInfo = file.chunks && file.chunks.length > 1 ? `<span class="file-repo-tag" title="已拆分存储">📦${file.chunks.length}片</span>` : '';

            return `
                <div class="file-item" data-index="${index}" data-path="${file.path}"
                     data-name="${file.name}" data-type="${type}" draggable="true">
                    ${chunkInfo}
                    <div class="file-icon">${icon}</div>
                    <div class="file-name" title="${file.name}">${file.name}</div>
                    ${size ? `<div class="file-meta">${size}</div>` : ''}
                </div>
            `;
        }).join('');

        container.querySelectorAll('.file-item').forEach(item => {
            const index = parseInt(item.dataset.index);
            const file = files[index];
            item.addEventListener('dblclick', () => this.app.openFile(file));
            item.addEventListener('click', (e) => { e.stopPropagation(); this.selectFile(item, file, e); });
            item.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showContextMenu(e, file); });
            // 移动端长按触发菜单
            let longPressTimer = null;
            let longPressPos = { x: 0, y: 0 };
            item.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                longPressPos = { x: touch.pageX, y: touch.pageY };
                longPressTimer = setTimeout(() => {
                    longPressTimer = null;
                    // 长按进入多选模式（而不是右键菜单）
                    this.enterMultiSelectMode(file, item);
                }, 500);
            }, { passive: true });
            item.addEventListener('touchmove', (e) => {
                if (!longPressTimer) return;
                const touch = e.touches[0];
                if (Math.abs(touch.pageX - longPressPos.x) > 10 || Math.abs(touch.pageY - longPressPos.y) > 10) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }, { passive: true });
            item.addEventListener('touchend', () => {
                if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            });
            // 拖拽移动
            item.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                this._draggedFile = file;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', file.path);
                item.style.opacity = '0.4';
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '';
                document.querySelectorAll('.file-item.drop-target').forEach(el => el.classList.remove('drop-target'));
            });
            if (file.isFolder) {
                item.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    item.classList.add('drop-target');
                });
                item.addEventListener('dragleave', (e) => {
                    e.stopPropagation();
                    item.classList.remove('drop-target');
                });
                item.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    item.classList.remove('drop-target');
                    document.getElementById('drop-overlay')?.classList.add('hidden');
                    const dragged = this._draggedFile;
                    if (dragged && dragged.path !== file.path && !dragged.path.startsWith(file.path + '/')) {
                        this.app.moveFileByDrag(dragged, file.path);
                    }
                });
            }
        });
        container.addEventListener('click', () => this.deselectFile());
    }

    /**
     * 显示加载状态
     */
    showLoading() {
        document.getElementById('file-list').innerHTML = '';
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('loading-state').classList.remove('hidden');
    }

    // ==================== 文件选择 ====================

    selectFile(element, file, event) {
        // 多选模式下点击切换选中
        if (this._multiSelectMode) {
            const idx = this.selectedFiles.findIndex(f => f.path === file.path);
            if (idx >= 0) {
                this.selectedFiles.splice(idx, 1);
                element.classList.remove('selected');
            } else {
                this.selectedFiles.push(file);
                element.classList.add('selected');
            }
            this.selectedFile = this.selectedFiles.length > 0 ? this.selectedFiles[this.selectedFiles.length - 1] : null;
            this.updateMultiSelectBar();
            if (this.selectedFiles.length === 0) this.exitMultiSelectMode();
            return;
        }
        const multi = event && (event.ctrlKey || event.metaKey);
        if (multi) {
            // Ctrl/Cmd 点击：切换选中
            const idx = this.selectedFiles.findIndex(f => f.path === file.path);
            if (idx >= 0) {
                this.selectedFiles.splice(idx, 1);
                element.classList.remove('selected');
            } else {
                this.selectedFiles.push(file);
                element.classList.add('selected');
            }
            this.selectedFile = this.selectedFiles.length > 0 ? this.selectedFiles[this.selectedFiles.length - 1] : null;
        } else {
            // 普通点击：单选
            document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
            element.classList.add('selected');
            this.selectedFile = file;
            this.selectedFiles = [file];
        }
    }

    deselectFile() {
        document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
        this.selectedFile = null;
        this.selectedFiles = [];
        this._multiSelectMode = false;
        document.body.classList.remove('multi-select-active');
        const bar = document.getElementById('multi-select-bar');
        if (bar) bar.classList.remove('visible');
    }

    // ==================== 多选模式（移动端） ====================

    selectAllFiles() {
        const items = document.querySelectorAll('.file-item');
        if (items.length === 0) return;
        // 获取所有文件数据
        const allFiles = [];
        items.forEach(item => {
            const path = item.dataset.path;
            const name = item.dataset.name;
            const type = item.dataset.type;
            allFiles.push({ path, name, isFolder: type === 'dir' });
        });
        // 进入多选模式
        if (!this._multiSelectMode) {
            this._multiSelectMode = true;
            document.getElementById('multi-select-bar')?.classList.remove('hidden');
        }
        this.selectedFiles = allFiles;
        // 更新 UI 选中状态
        items.forEach(item => item.classList.add('selected'));
        this.updateMultiSelectBar();
    }

    enterMultiSelectMode(file, element) {
        this._multiSelectMode = true;
        document.body.classList.add('multi-select-active');
        this.selectedFiles = [file];
        this.selectedFile = file;
        document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
        if (element) element.classList.add('selected');
        const bar = document.getElementById('multi-select-bar');
        if (bar) bar.classList.add('visible');
        this.updateMultiSelectBar();
        if (navigator.vibrate) navigator.vibrate(50);
    }

    exitMultiSelectMode() {
        this._multiSelectMode = false;
        document.body.classList.remove('multi-select-active');
        this.selectedFiles = [];
        this.selectedFile = null;
        document.querySelectorAll('.file-item').forEach(el => el.classList.remove('selected'));
        const bar = document.getElementById('multi-select-bar');
        if (bar) bar.classList.remove('visible');
    }

    updateMultiSelectBar() {
        const count = this.selectedFiles.length;
        const countEl = document.getElementById('multi-select-count');
        if (countEl) countEl.textContent = count + ' 项已选';
        const btns = document.querySelectorAll('#multi-select-bar .ms-btn');
        btns.forEach(btn => {
            btn.disabled = count === 0;
            btn.style.opacity = count === 0 ? '0.5' : '1';
        });
    }

    multiSelectAction(action) {
        const files = this.selectedFiles;
        if (files.length === 0) return;
        switch (action) {
            case 'download':
                files.forEach(f => this.app.downloadFile(f));
                this.showToast('开始下载 ' + files.length + ' 个文件', 'info');
                break;
            case 'delete':
                if (confirm('确定删除选中的 ' + files.length + ' 个文件吗？')) {
                    files.forEach(f => this.app.deleteFile(f));
                    this.showToast('已删除 ' + files.length + ' 个文件', 'success');
                }
                break;
            case 'move':
                this.exitMultiSelectMode();
                this.showMoveModal(files);
                break;
            case 'selectAll':
                const allItems = document.querySelectorAll('.file-item');
                const allFiles = [];
                allItems.forEach(el => {
                    el.classList.add('selected');
                    allFiles.push({ path: el.dataset.path, name: el.dataset.name, type: el.dataset.type });
                });
                this.selectedFiles = allFiles;
                this.updateMultiSelectBar();
                break;
        }
        if (action === 'delete' || action === 'download') {
            setTimeout(() => this.exitMultiSelectMode(), 500);
        }
    }

    // ==================== 右键菜单 ====================

    showContextMenu(event, file) {
        this.contextMenuTarget = file;
        var B = window.Bridge;

        // 没有 Bridge 时退回旧菜单，保证功能不丢
        if (!B || !B.createMenu) { return this._showContextMenuLegacy(event, file); }

        if (this._ctxMenu) this._ctxMenu.hide();
        this._ctxMenu = B.createMenu(this._buildContextItems(file), {
            onClose: () => { this._ctxMenu = null; }
        });
        this._ctxMenu.show(event.clientX, event.clientY);
    }

    /**
     * 构建右键菜单项（二级菜单分组）
     *
     * 原来 11 项平铺，菜单高达 400px+，在笔记本屏幕上必然被裁。
     * 现在分两层：常用操作直接可见，高级操作收进「更多」。
     */
    _buildContextItems(file) {
        var self = this;
        var I = window.Icons;
        var ico = function (n, sz) { return I ? I.get(n, { size: sz || 15 }) : ''; };

        var isFolder = file.type === 'folder';
        var isStarred = this.app.storage.isFavorite(file.path);
        var multi = (this.selectedFiles || []).length > 1 &&
                    this.selectedFiles.some(f => f.path === file.path);

        // 多选时提示作用于全部选中项
        var suffix = multi ? ` (${this.selectedFiles.length} 项)` : '';
        var act = function (a) { return function () { self.handleContextAction(a, file); }; };

        return [
            { icon: ico('folderOpen'), label: '打开', onClick: act('open'), shortcut: 'Enter' },
            { icon: ico('download'), label: '下载' + suffix, onClick: act('download') },
            { sep: true },
            { icon: ico('share'), label: '分享', onClick: act('share') },
            {
                icon: ico('moreH'), label: '更多操作',
                children: [
                    { icon: ico('edit'), label: '重命名', onClick: act('rename') },
                    { icon: ico('move'), label: '移动到…', onClick: act('move') },
                    { icon: ico('copy'), label: '复制到…', onClick: act('copy') },
                    { sep: true },
                    { icon: ico('edit'), label: '编辑文件', onClick: act('edit'), disabled: isFolder },
                    { icon: ico('tag'), label: '标签管理', onClick: act('tags') },
                    { icon: ico('history'), label: '版本历史', onClick: act('history') }
                ]
            },
            {
                icon: ico('star'), label: isStarred ? '取消收藏' : '收藏',
                onClick: act('star')
            },
            { sep: true },
            { icon: ico('trash'), label: '删除' + suffix, onClick: act('delete'), danger: true, shortcut: 'Del' }
        ];
    }

    /** 旧版静态菜单（Bridge 不可用时的降级路径） */
    _showContextMenuLegacy(event, file) {
        const menu = document.getElementById('context-menu');
        const isStarred = this.app.storage.isFavorite(file.path);
        const starItem = menu.querySelector('[data-action="star"]');
        starItem.textContent = isStarred ? '💔 ' + I18n.t('menu.unstar') : '⭐ ' + I18n.t('menu.star');
        menu.classList.remove('hidden');
        var B = window.Bridge;
        if (B && B.placeMenu) {
            B.placeMenu(menu, event.clientX, event.clientY);
        } else {
            menu.style.left = event.clientX + 'px';
            menu.style.top = event.clientY + 'px';
        }
        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                this.handleContextAction(item.dataset.action, file);
                this.hideContextMenu();
            };
        });
    }

    hideContextMenu() {
        if (this._ctxMenu) { this._ctxMenu.hide(); this._ctxMenu = null; }
        const legacy = document.getElementById('context-menu');
        if (legacy) legacy.classList.add('hidden');
        this.contextMenuTarget = null;
    }

    handleContextAction(action, file) {
        // 获取要操作的文件列表：多选时操作所有选中文件
        const getActionFiles = () => {
            if (this.selectedFiles.length > 1 && this.selectedFiles.some(f => f.path === file.path)) {
                return this.selectedFiles;
            }
            return [file];
        };
        switch (action) {
            case 'open':
                this.app.openFile(file);
                break;
            case 'download':
                getActionFiles().forEach(f => this.app.downloadFile(f));
                break;
            case 'share':
                this.showShareModal(getActionFiles());
                break;
            case 'edit':
                this.app.editFile(file);
                break;
            case 'history':
                this.app.showFileHistory(file);
                break;
            case 'tags':
                this.app.showTagManager(file);
                break;
            case 'rename':
                this.showRenameModal(file);
                break;
            case 'move':
                this.showMoveModal(getActionFiles());
                break;
            case 'copy':
                this.showCopyModal(getActionFiles());
                break;
            case 'star':
                getActionFiles().forEach(f => this.app.toggleStar(f));
                break;
            case 'delete':
                this.app.deleteFiles(getActionFiles());
                break;
        }
    }

    // ==================== 拖拽上传 ====================

    setupDragAndDrop() {
        const fileArea = document.querySelector('.file-area');
        const dropOverlay = document.getElementById('drop-overlay');

        // 用 relatedTarget 判断是否真的离开，避免子元素 stopPropagation 导致计数错误
        fileArea.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dropOverlay.classList.remove('hidden');
        });

        fileArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            // dragover 时确保遮罩显示（防止各种异常情况）
            dropOverlay.classList.remove('hidden');
        });

        fileArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            // 只有当 relatedTarget 不在 fileArea 内时，才真正隐藏
            const related = e.relatedTarget;
            if (!related || !fileArea.contains(related)) {
                dropOverlay.classList.add('hidden');
            }
        });

        // 额外监听 document 的 dragleave，防止离开窗口时遮罩不消失
        document.addEventListener('dragleave', (e) => {
            if (e.relatedTarget === null) {
                dropOverlay.classList.add('hidden');
            }
        });

        fileArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropOverlay.classList.add('hidden');
            const items = e.dataTransfer.items;
            if (items && items.length > 0 && items[0].webkitGetAsEntry) {
                const entries = [];
                for (let i = 0; i < items.length; i++) {
                    const entry = items[i].webkitGetAsEntry();
                    if (entry) entries.push(entry);
                }
                const files = await this.readEntriesRecursive(entries);
                if (files.length > 0) {
                    const hasFolder = files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
                    if (hasFolder) {
                        this.app.uploadFolder(files);
                    } else {
                        this.app.uploadFiles(files);
                    }
                }
            } else {
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) {
                    this.app.uploadFiles(files);
                }
            }
        });
    }

    async readEntriesRecursive(entries) {
        const files = [];
        for (const entry of entries) {
            if (entry.isFile) {
                const file = await new Promise(resolve => entry.file(resolve));
                files.push(file);
            } else if (entry.isDirectory) {
                const dirFiles = await this.readDirectoryRecursive(entry, entry.name);
                files.push(...dirFiles);
            }
        }
        return files;
    }

    async readDirectoryRecursive(dirEntry, path) {
        const files = [];
        const reader = dirEntry.createReader();
        let allEntries = [];
        let entries;
        do {
            entries = await new Promise(resolve => reader.readEntries(resolve));
            allEntries = allEntries.concat(entries);
        } while (entries.length > 0);
        for (const entry of allEntries) {
            if (entry.isFile) {
                const file = await new Promise(resolve => entry.file(resolve));
                Object.defineProperty(file, 'webkitRelativePath', { value: path + '/' + file.name, configurable: true });
                files.push(file);
            } else if (entry.isDirectory) {
                const subFiles = await this.readDirectoryRecursive(entry, path + '/' + entry.name);
                files.push(...subFiles);
            }
        }
        return files;
    }

    triggerFileUpload() {
        document.getElementById('file-input').click();
    }

    triggerFolderUpload() {
        document.getElementById('folder-input').click();
    }

    // 视图切换（网格/列表）
    toggleView() {
        const list = document.getElementById('file-list');
        const isList = list.classList.toggle('list-view');
        const icon = document.getElementById('view-toggle-icon');
        if (icon) icon.textContent = isList ? '▦' : '☰';
        localStorage.setItem('github_drive_view', isList ? 'list' : 'grid');
        this.showToast(isList ? I18n.t('toast.listView') : I18n.t('toast.gridView'), 'info');
    }

    applyViewPreference() {
        const view = localStorage.getItem('github_drive_view') || 'grid';
        const list = document.getElementById('file-list');
        const icon = document.getElementById('view-toggle-icon');
        if (view === 'list') {
            list.classList.add('list-view');
            if (icon) icon.textContent = '▦';
        } else {
            list.classList.remove('list-view');
            if (icon) icon.textContent = '☰';
        }
    }

    // ==================== 模态框 ====================

    showBackendManager() {
        const config = this.app.getBackendConfig();
        const backendUrl = (config && config.url) || 'http://localhost:8787';
        const body = `
            <div id="backend-manager">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
                    <div style="background:#f0fdf4;padding:14px;border-radius:10px;border:1px solid #bbf7d0;">
                        <div style="font-size:11px;color:#16a34a;text-transform:uppercase;margin-bottom:4px;"><span data-i18n='backend.status'>Status</span></div>
                        <div id="bm-status" style="font-size:18px;font-weight:700;color:#16a34a;">检测中...</div>
                    </div>
                    <div style="background:#eff6ff;padding:14px;border-radius:10px;border:1px solid #bfdbfe;">
                        <div style="font-size:11px;color:#2563eb;text-transform:uppercase;margin-bottom:4px;"><span data-i18n='backend.version'>Version</span></div>
                        <div id="bm-version" style="font-size:18px;font-weight:700;color:#2563eb;">--</div>
                    </div>
                    <div style="background:#faf5ff;padding:14px;border-radius:10px;border:1px solid #e9d5ff;">
                        <div style="font-size:11px;color:#7c3aed;text-transform:uppercase;margin-bottom:4px;"><span data-i18n='backend.port'>Port</span></div>
                        <div id="bm-port" style="font-size:18px;font-weight:700;color:#7c3aed;">--</div>
                    </div>
                    <div style="background:#fffbeb;padding:14px;border-radius:10px;border:1px solid #fde68a;">
                        <div style="font-size:11px;color:#d97706;text-transform:uppercase;margin-bottom:4px;"><span data-i18n='backend.uptime'>Uptime</span></div>
                        <div id="bm-uptime" style="font-size:18px;font-weight:700;color:#d97706;">--</div>
                    </div>
                </div>
                <div style="background:#f9fafb;padding:12px;border-radius:8px;margin-bottom:12px;font-size:12px;">
                    <div style="color:#6b7280;margin-bottom:4px;"><span data-i18n='backend.exePath'>📁 Executable Path</span></div>
                    <div id="bm-path" style="color:#374151;font-family:monospace;word-break:break-all;">--</div>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
                    <button class="btn-primary btn-sm" onclick="ui.refreshBackendManager()"><span data-i18n='backend.refresh'>🔄 Refresh</span></button>
                    <button class="btn-secondary btn-sm" onclick="ui.showBackendSettings()"><span data-i18n='backend.configAuth'>⚙️ Config/Auth</span></button>
                    <button class="btn-secondary btn-sm" onclick="ui.checkBackendUpdate()"><span data-i18n='backend.checkUpdate'>⬆️ Check Update</span></button>
                    <button class="btn-secondary btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;" onclick="ui.shutdownBackend()"><span data-i18n='backend.shutdown'>⏹️ Shutdown</span></button>
                    <button class="btn-secondary btn-sm" onclick="ui.downloadBackendAuto(true)"><span data-i18n='backend.downloadNew'>⬇️ Download New</span></button>
                </div>
                <div style="margin-bottom:8px;font-size:13px;font-weight:600;color:#374151;"><span data-i18n='backend.logsTitle'>📋 Request Logs (last 100)</span></div>
                <div id="bm-logs" style="background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:8px;font-family:monospace;font-size:11px;max-height:300px;overflow-y:auto;line-height:1.6;">
                    <div style="color:#6c7086;">加载中...</div>
                </div>
            </div>`;
        this.showModal(I18n.t('backend.title') || '⚙️ 后端服务管理', body, '', true);
        I18n.apply();
        this.refreshBackendManager();
    }

    async refreshBackendManager() {
        const config = this.app.getBackendConfig();
        const url = (config && config.url) || 'http://localhost:8787';
        let data = null;
        // 先尝试 /api/status（新版）
        try {
            const resp = await fetch(url + '/api/status');
            if (resp.ok) data = await resp.json();
        } catch (e) {}
        // 回退到 /health（旧版兼容）
        if (!data) {
            try {
                const resp = await fetch(url + '/health');
                if (resp.ok) {
                    const h = await resp.json();
                    data = { status: h.status, version: h.version || '?', port: url.split(':').pop(), uptime: 0, exePath: '未知（旧版后端）' };
                }
            } catch (e) {}
        }
        if (data && data.status === 'running') {
            document.getElementById('bm-status').textContent = I18n.t('backend.running');
            document.getElementById('bm-status').style.color = '#16a34a';
            document.getElementById('bm-version').textContent = 'v' + data.version;
            document.getElementById('bm-port').textContent = data.port;
            const s = data.uptime || 0;
            const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
            document.getElementById('bm-uptime').textContent = (h>0?h+'时':'')+(m>0?m+'分':'')+sec+'秒';
            document.getElementById('bm-path').textContent = data.exePath || '未知';
        } else {
            document.getElementById('bm-status').textContent = I18n.t('backend.notConnected');
            document.getElementById('bm-status').style.color = '#dc2626';
            document.getElementById('bm-logs').innerHTML = '<div style="color:#f38ba8;">无法连接后端服务，请确认已启动。</div>';
            return;
        }
        // 加载日志（无需授权）
        try {
            const logResp = await fetch(url + '/api/logs');
            const logData = await logResp.json();
            const logs = logData.logs || [];
            if (logs.length === 0) {
                document.getElementById('bm-logs').innerHTML = '<div style="color:#6c7086;">' + I18n.t('backend.noLogs') + '</div>';
            } else {
                document.getElementById('bm-logs').innerHTML = logs.map(l =>
                    '<div><span style="color:#6c7086;">' + l.time + '</span> ' +
                    '<span style="color:' + (l.status < 400 ? '#a6e3a1' : '#f38ba8') + ';">' + l.status + '</span> ' +
                    '<span style="color:#89b4fa;">' + l.method + '</span> ' +
                    '<span style="color:#cdd6f4;">' + l.path + '</span></div>'
                ).join('');
            }
        } catch (e) {
            document.getElementById('bm-logs').innerHTML = '<div style="color:#f38ba8;">' + I18n.t('backend.logsFailed') + '</div>';
        }
    }

    async checkBackendUpdate() {
        const config = this.app.getBackendConfig();
        const url = (config && config.url) || 'http://localhost:8787';
        this.showToast(I18n.t('backend.checkingUpdate'), 'info');
        try {
            const resp = await fetch(url + '/api/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await resp.json();
            if (data.status === 'updating') {
                this.showToast(I18n.t('backend.downloading'), 'success');
            } else {
                this.showToast('更新失败: ' + (data.error || '未知错误'), 'error');
            }
        } catch (e) {
            this.showToast('检查更新失败: ' + e.message, 'error');
        }
    }

    async shutdownBackend() {
        if (!confirm(I18n.t('backend.shutdownConfirm'))) return;
        const config = this.app.getBackendConfig();
        const url = (config && config.url) || 'http://localhost:8787';
        try {
            // 后端停止时会立即关闭连接，导致 fetch 报错，这是正常的
            // 用 AbortController 设置超时，超时或网络错误都视为停止成功
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 3000);
            await fetch(url + '/api/shutdown', { method: 'POST', signal: controller.signal });
            this.showToast(I18n.t('backend.stopped'), 'success');
        } catch (e) {
            // 网络错误（连接被拒绝/超时/中止）都视为后端已停止
            if (e.name === 'AbortError' || e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
                this.showToast(I18n.t('backend.stopped'), 'success');
            } else {
                this.showToast(I18n.t('backend.stopFailed') + ': ' + e.message, 'error');
            }
        }
        setTimeout(() => this.refreshBackendManager(), 500);
    }

    showHelp() {
        var rows = [
            {k: 'Ctrl + A', d: I18n.t('help.selectAll')},
            {k: 'Delete / Backspace', d: I18n.t('help.delete')},
            {k: 'F2', d: I18n.t('help.rename')},
            {k: 'Ctrl + D', d: I18n.t('help.favorite')},
            {k: '/', d: I18n.t('help.search')},
            {k: 'Esc', d: I18n.t('help.esc')},
            {k: 'Ctrl + Click', d: I18n.t('help.multiSelect')},
            {k: 'Drag files', d: I18n.t('help.drag')}
        ];
        var html = '';
        for (var i = 0; i < rows.length; i++) {
            html += '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f3f4f6;">';
            html += '<kbd style="background:#f3f4f6;padding:2px 8px;border-radius:4px;font-size:12px;font-family:monospace;">' + rows[i].k + '</kbd>';
            html += '<span style="color:#4b5563;font-size:13px;">' + rows[i].d + '</span>';
            html += '</div>';
        }
        var body = '<div style="margin-bottom:20px;">';
        body += '<h4 style="margin:0 0 10px 0;color:#111827;">' + I18n.t('help.shortcuts') + '</h4>';
        body += html;
        body += '</div>';
        body += '<div style="margin-bottom:20px;">';
        body += '<h4 style="margin:0 0 10px 0;color:#111827;">' + I18n.t('help.tips') + '</h4>';
        body += '<ul style="margin:0;padding-left:20px;color:#4b5563;font-size:13px;line-height:1.8;">';
        body += '<li>' + I18n.t('help.tip1') + '</li>';
        body += '<li>' + I18n.t('help.tip2') + '</li>';
        body += '<li>' + I18n.t('help.tip3') + '</li>';
        body += '<li>' + I18n.t('help.tip4') + '</li>';
        body += '<li>' + I18n.t('help.tip5') + '</li>';
        body += '</ul></div>';
        body += '<div style="background:#f9fafb;padding:12px;border-radius:8px;font-size:12px;color:#6b7280;">GitHub Drive v1.0 | 基于 GitHub API 的虚拟文件系统</div>';
        this.showModal(I18n.t('help.title'), body, '', true);
    }

    toggleDarkMode() {
        document.body.classList.toggle('dark-mode');
        const isDark = document.body.classList.contains('dark-mode');
        localStorage.setItem('gd_dark_mode', isDark ? '1' : '0');
        this.showToast(isDark ? '🌙 已切换到暗色模式' : '☀️ 已切换到浅色模式', 'success');
        // 刷新设置页面显示
        this.showSettings();
    }

    initDarkMode() {
        if (localStorage.getItem('gd_dark_mode') === '1') {
            document.body.classList.add('dark-mode');
        }
    }

    showSettings() {
        var versionEl = document.getElementById('app-version');
        var repoSizeEl = document.getElementById('repo-size-display');
        var version = versionEl ? versionEl.textContent : 'v-';
        var repoSize = repoSizeEl ? repoSizeEl.textContent : '📦 --';
        var items = [
            {icon:'🌙', title:I18n.t('settings.darkMode') || '暗色模式', desc:I18n.t('settings.darkModeDesc') || '切换深色/浅色主题', action:'ui.toggleDarkMode();'},
            {icon:'🌐', title:I18n.t('settings.language'), desc:I18n.t('settings.languageDesc'), action:'I18n.toggle();ui.closeModal();'},
            {icon:'⚙️', title:I18n.t('settings.backend'), desc:I18n.t('settings.backendDesc'), action:'ui.closeModal();ui.showBackendManager();'},

            {icon:'❓', title:I18n.t('settings.help'), desc:I18n.t('settings.helpDesc'), action:'ui.closeModal();ui.showHelp();'},
            {icon:'📖', title:I18n.t('settings.docs'), desc:I18n.t('settings.docsDesc'), action:"window.open('https://cool-zimo.github.io/github_drive_documentation/','_blank');"},
            {icon:'🔀', title:I18n.t('settings.versionSwitch') || '版本切换', desc:I18n.t('settings.versionSwitchDesc') || '体验他人改进的版本', action:'ui.closeModal();ui.showVersionSwitcher();'},
            {icon:'🔍', title:I18n.t('settings.contentSearch') || '内容搜索', desc:I18n.t('settings.contentSearchDesc') || '搜索时同时匹配文件内容', action:'ui.toggleContentSearch();'},
            {icon:'🎯', title:'智能分类', desc:'按文件类型自动整理到文件夹', action:'ui.closeModal();app.showCategoryStats();'},
            {icon:'📊', title:I18n.t('settings.storageStats') || '存储用量', desc:I18n.t('settings.storageStatsDesc') || '查看文件统计和仓库大小', action:'ui.closeModal();app.showStorageStats();'},
            {icon:'💾', title:I18n.t('settings.export'), desc:I18n.t('settings.exportDesc'), action:'app.exportBackup();ui.closeModal();'},
            {icon:'🏷️', title:I18n.t('settings.version'), desc:'GitHub Drive', extra:version},
            {icon:'🚪', title:I18n.t('settings.logout'), desc:I18n.t('settings.logoutDesc'), action:"if(confirm(I18n.t('settings.logoutConfirm'))){app.logout();ui.closeModal();}", danger:true}
        ];
        var body = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var extraHtml = it.extra ? ' <span style="font-weight:400;font-size:13px;color:#6b7280;">' + it.extra + '</span>' : '';
            var color = it.danger ? 'color:#dc2626;' : '';
            var hoverBg = it.danger ? '#fef2f2' : '#f3f4f6';
            body += '<div onclick="' + (it.action || '') + '" style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;cursor:pointer;margin-bottom:8px;' + color + '" onmouseover="this.style.background=\"' + hoverBg + '\"" onmouseout="this.style.background=\"transparent\"">';
            body += '<span style="font-size:20px;">' + it.icon + '</span>';
            body += '<div><div style="font-weight:600;font-size:14px;">' + it.title + extraHtml + '</div><div style="font-size:12px;color:#6b7280;">' + it.desc + '</div></div></div>';
        }
        this.showModal(I18n.t('settings.title'), body, '', true);
    }

    showVersionSwitcher() {
        const currentBranch = localStorage.getItem('gd_custom_branch') || 'main';
        const body = `
            <div style="padding:8px 0;">
                <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;margin-bottom:16px;">
                    <div style="font-size:13px;color:#1e40af;font-weight:600;margin-bottom:4px;">💡 版本广场</div>
                    <div style="font-size:12px;color:#1e40af;line-height:1.5;">
                        开发者通过 Pull Request 提交改进，系统自动创建预览分支并展示在这里。<br>
                        点击任意版本即可加载体验。
                    </div>
                </div>
                
                <div style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
                    <div>
                        <div style="font-size:12px;color:#6b7280;">当前版本</div>
                        <div style="font-family:monospace;font-size:14px;font-weight:600;color:#374151;">${currentBranch === 'main' ? '🏠 官方版 (main)' : '🔀 ' + currentBranch}</div>
                    </div>
                    ${currentBranch !== 'main' ? '<button onclick="ui.resetToMain()" style="padding:8px 14px;background:#f3f4f6;color:#374151;border:none;border-radius:6px;cursor:pointer;font-size:12px;">🏠 恢复官方版</button>' : ''}
                </div>
                
                <div style="border-top:1px solid #e5e7eb;padding-top:12px;">
                    <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:10px;">🌟 社区版本</div>
                    <div id="version-plaza" style="max-height:400px;overflow-y:auto;">
                        <div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px;">加载中...</div>
                    </div>
                </div>
                
                <div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;">
                    <details style="font-size:12px;color:#6b7280;">
                        <summary style="cursor:pointer;">⚙️ 高级：手动输入分支名</summary>
                        <div style="margin-top:8px;display:flex;gap:8px;">
                            <input type="text" id="branch-input" placeholder="preview/author/feature-name" 
                                style="flex:1;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;font-family:monospace;">
                            <button onclick="ui.switchBranch()" style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">加载</button>
                        </div>
                    </details>
                </div>
            </div>
        `;
        this.showModal('🌐 版本广场', body, '', true);
        this.loadVersionPlaza();
    }

    async loadVersionPlaza() {
        try {
            // 从 main 分支读取 preview-branches.json 配置清单
            const res = await fetch('https://raw.githubusercontent.com/Cool-zimo/github_drive/main/preview-branches.json?t=' + Date.now());
            if (!res.ok) throw new Error('配置清单加载失败');
            const data = await res.json();
            
            const plazaEl = document.getElementById('version-plaza');
            if (!plazaEl) return;
            
            if (!data.branches || data.branches.length === 0) {
                plazaEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">暂无社区版本<br><span style="font-size:11px;">成为第一个贡献者吧！</span></div>';
                return;
            }
            
            plazaEl.innerHTML = data.branches.map(b => {
                const isCurrent = localStorage.getItem('gd_custom_branch') === b.branch;
                return `
                <div onclick="ui.loadVersion('${b.branch}')" 
                    style="padding:12px;border:1px solid ${isCurrent ? '#2563eb' : '#e5e7eb'};border-radius:8px;margin-bottom:8px;cursor:pointer;background:${isCurrent ? '#eff6ff' : '#fff'};"
                    onmouseover="this.style.borderColor='#2563eb';this.style.background='#f8fafc'" 
                    onmouseout="this.style.borderColor='${isCurrent ? '#2563eb' : '#e5e7eb'}';this.style.background='${isCurrent ? '#eff6ff' : '#fff'}'">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                        <div style="font-weight:600;font-size:14px;color:#111827;">${this.escapeHtml(b.name || b.branch)}</div>
                        <span style="font-size:11px;background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;">v${b.version || '1.0.0'}</span>
                    </div>
                    <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">👤 ${this.escapeHtml(b.author || 'unknown')}</div>
                    <div style="font-size:12px;color:#374151;line-height:1.4;">${this.escapeHtml(b.description || '暂无描述')}</div>
                    <div style="font-size:11px;color:#9ca3af;margin-top:6px;font-family:monospace;">${b.branch}</div>
                    ${isCurrent ? '<div style="font-size:11px;color:#2563eb;margin-top:4px;font-weight:600;">✅ 当前使用中</div>' : ''}
                </div>`;
            }).join('');
        } catch (e) {
            const plazaEl = document.getElementById('version-plaza');
            if (plazaEl) plazaEl.innerHTML = '<div style="text-align:center;padding:20px;color:#ef4444;font-size:13px;">加载失败: ' + e.message + '<br><span style="font-size:11px;color:#9ca3af;">请检查网络连接</span></div>';
        }
    }
    
    loadVersion(branch) {
        localStorage.setItem('gd_custom_branch', branch);
        alert('正在加载版本: ' + branch + '\n页面将刷新以加载新版本。');
        location.reload();
    }

    switchBranch() {
        const branch = document.getElementById('branch-input').value.trim();
        if (!branch) { alert('请输入分支名'); return; }
        
        localStorage.setItem('gd_custom_branch', branch);
        alert('已切换到分支: ' + branch + '\n页面将刷新以加载新版本。\n\n注意：如果分支不存在或 Pages 未部署，页面可能无法正常加载。');
        location.reload();
    }

    resetToMain() {
        localStorage.removeItem('gd_custom_branch');
        alert('已恢复官方版本 (main)，页面将刷新。');
        location.reload();
    }

    showBackendSettings() {
        const config = this.app.getBackendConfig();
        const body = `
            <div style="padding:8px 0">
                <div style="background:#f0f9ff;padding:12px;border-radius:8px;margin-bottom:16px;font-size:13px;color:#0369a1;line-height:1.5">
                    <span data-i18n='backend.settingsDesc'>💡 Backend provides network, file ops, command execution for plugins.</span><br>
                    <a href="https://github.com/Cool-zimo/github-drive-server" target="_blank" style="color:#0369a1;text-decoration:underline">后端服务仓库</a> · 
                    <a href="#" onclick="ui.downloadBackendAuto(true);return false;" style="color:#0369a1;text-decoration:underline"><span data-i18n='backend.fastDownload'>⚡ Fast Download</span></a> · 
                    <a href="#" onclick="ui.downloadBackendAuto(false);return false;" style="color:#0369a1;text-decoration:underline"><span data-i18n='backend.officialSource'>Official</span></a>
                    <br>下载后双击运行即可，无需授权码。
                </div>
                <div style="margin-bottom:12px">
                    <label style="display:block;font-size:13px;color:#374151;margin-bottom:4px">后端地址</label>
                    <input type="text" id="backend-url" value="${config.url || 'http://localhost:8787'}" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
                </div>
                <div id="backend-status" style="font-size:12px;color:#6b7280;margin-bottom:12px">未测试</div>
                <div style="display:flex;gap:8px">
                    <button onclick="ui.testBackend()" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:6px;background:#f3f4f6;cursor:pointer;font-size:13px">测试连接</button>
                    <button onclick="ui.saveBackendConfig()" style="flex:1;padding:10px;border:none;border-radius:6px;background:#667eea;color:#fff;cursor:pointer;font-size:13px;font-weight:600">保存</button>
                </div>
            </div>`;
        this.showModal(I18n.t('backend.settings') || '⚙️ 后端服务设置', body);
    }


    BACKEND_LATEST_VERSION = 'v2.2.0';

    async downloadBackendAuto(preferMirror = true) {
        const ua = navigator.userAgent;
        const v = this.BACKEND_LATEST_VERSION;
        let file = 'github-drive-server-' + v + '-linux';
        if (/Windows/i.test(ua)) file = 'github-drive-server-' + v + '-windows.exe';
        else if (/Mac/i.test(ua)) {
            if (/Apple Silicon|arm64|aarch64/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.hardwareConcurrency > 8))
                file = 'github-drive-server-' + v + '-macos-apple';
            else file = 'github-drive-server-' + v + '-macos-intel';
        }
        const mirrorUrl = 'https://ghproxy.com/https://raw.githubusercontent.com/Cool-zimo/github-drive-server/main/dist/' + file;
        const officialUrl = 'https://cool-zimo.github.io/github-drive-server/dist/' + file;

        let downloadUrl = officialUrl;
        let sourceName = I18n.t('backend.officialSource');
        if (preferMirror) {
            // 先检测加速源是否可达
            try {
                const ctrl = new AbortController();
                setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(mirrorUrl, { method: 'HEAD', signal: ctrl.signal, mode: 'no-cors' });
                downloadUrl = mirrorUrl;
                sourceName = '加速源';
            } catch {
                this.showToast(I18n.t('backend.mirrorFallback'), 'warning');
                downloadUrl = officialUrl;
                sourceName = I18n.t('backend.officialSource');
            }
        }
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = file;
        document.body.appendChild(a);
        a.click();
        a.remove();
        this.showToast(I18n.t('backend.downloadingFrom') + sourceName + '下载后端服务...', 'info');
        setTimeout(() => this.showBackendSettings(), 1000);
    }

    async testBackend() {
        const url = document.getElementById('backend-url').value.trim().replace(/\/$/, '');
        const status = document.getElementById('backend-status');
        status.textContent = I18n.t('backend.testing');
        status.style.color = '#6b7280';
        try {
            const resp = await fetch(url + '/api/status');
            const data = await resp.json();
            if (data.status === 'running') {
                status.textContent = I18n.t('backend.connected') + ' v' + data.version;
                status.style.color = '#16a34a';
            } else {
                status.textContent = I18n.t('backend.serviceError');
                status.style.color = '#dc2626';
            }
        } catch (e) {
            try {
                const resp2 = await fetch(url + '/health');
                const data2 = await resp2.json();
                if (data2.status === 'running') {
                    status.innerHTML = I18n.t('backend.oldVersion') + ' v' + (data2.version || '?') + ' <a href="#" onclick="ui.downloadBackendAuto();return false;" style="color:#2563eb;text-decoration:underline">更新</a>';
                    status.style.color = '#d97706';
                } else throw new Error('服务异常');
            } catch (e2) {
                status.textContent = '❌ 无法连接: ' + e.message;
                status.style.color = '#dc2626';
            }
        }
    }

    saveBackendConfig() {
        const url = document.getElementById('backend-url').value.trim().replace(/\/$/, '');
        this.app.saveBackendConfig({ url });
        this.showToast(I18n.t('backend.addrSaved'), 'success');
        this.closeModal();
    }

    showModal(title, bodyContent, footerContent = '', large = false) {
        const container = document.getElementById('modal-container');
        container.innerHTML = `
            <div class="modal-overlay">
                <div class="modal${large ? ' modal-large' : ''}">
                    <div class="modal-header">
                        <h3>${title}</h3>
                        <button class="modal-close" onclick="ui.closeModal()">×</button>
                    </div>
                    <div class="modal-body">${bodyContent}</div>
                    ${footerContent ? `<div class="modal-footer">${footerContent}</div>` : ''}
                </div>
            </div>
        `;
    }

    closeModal() {
        this._pagesMonitorStopped = true;
        document.getElementById('modal-container').innerHTML = '';
    }

    /**
     * 新建文件夹模态框
     */

    // ==================== 在线文件编辑器 ====================
    showOnlineEditor(file, content) {
        const isCode = /\.(js|py|json|html|css|md|txt|xml|yml|yaml|toml|cfg|ini|sh|bat|java|c|cpp|go|rs|ts|jsx|tsx|vue)$/i.test(file.name);
        const lang = file.name.split('.').pop().toLowerCase();
        
        const body = '<div style="padding:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;">' +
            '<span style="font-size:14px;font-weight:600;">📝 ' + file.name + '</span>' +
            '<span style="font-size:11px;color:#6b7280;background:#e5e7eb;padding:2px 8px;border-radius:4px;">' + lang.toUpperCase() + '</span>' +
            '<span id="editor-status" style="font-size:12px;color:#6b7280;margin-left:auto;">已加载</span>' +
            '</div>' +
            '<textarea id="editor-textarea" style="width:100%;height:400px;border:none;outline:none;padding:16px;font-family:monospace;font-size:13px;line-height:1.6;resize:none;background:#fff;color:#1f2937;" spellcheck="false">' + (content || '') + '</textarea>' +
            '</div>';
        
        const footer = '<div style="display:flex;gap:8px;">' +
            '<button onclick="ui.closeModal()" style="padding:8px 20px;background:#f3f4f6;border:none;border-radius:6px;cursor:pointer;font-size:14px;">取消</button>' +
            '<button onclick="app.saveEditedFile()" style="padding:8px 20px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">💾 保存</button>' +
            '</div>';
        
        this.showModal('📝 在线编辑器', body, footer, true);
    }

    showNewFolderModal() {
        this.showModal(
            '新建文件夹',
            `
                <div class="form-group">
                    <label>文件夹名称</label>
                    <input type="text" id="new-folder-name" placeholder="输入文件夹名称" autofocus>
                </div>
            `,
            `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" onclick="app.createFolder()">创建</button>
            `
        );
        setTimeout(() => document.getElementById('new-folder-name')?.focus(), 100);
    }

    /**
     * 创建仓库模态框
     */
    showCreateRepoModal() {
        this.showModal(
            '创建存储仓库',
            `
                <div class="form-group">
                    <label>仓库名称</label>
                    <input type="text" id="new-repo-name" placeholder="my-drive-storage" autofocus>
                    <p class="form-hint">仓库将创建为私有仓库，用于存储你的文件</p>
                </div>
                <div class="form-group">
                    <label>描述（可选）</label>
                    <input type="text" id="new-repo-desc" placeholder="仓库描述">
                </div>
            `,
            `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" onclick="app.createRepository()">创建仓库</button>
            `
        );
        setTimeout(() => document.getElementById('new-repo-name')?.focus(), 100);
    }

    /**
     * 关联已有仓库模态框
     */
    async showLinkRepoModal() {
        this.showModal(I18n.t('repo.associate'), '<div class="loading-state"><div class="spinner"></div><p>加载仓库列表...</p></div>');

        try {
            const repos = await this.app.api.listRepositories(50);
            const linkedRepos = this.app.storage.getRepos();
            const linkedNames = linkedRepos.map(r => `${r.owner}/${r.repo}`);

            const availableRepos = repos.filter(r => !linkedNames.includes(`${r.owner.login}/${r.name}`));

            const body = `
                <div class="form-group">
                    <label>选择要关联的仓库</label>
                    <div class="repo-selector" id="repo-selector">
                        ${availableRepos.length === 0 ? '<div style="padding:20px;text-align:center;color:#8c959f;">没有可关联的仓库</div>' :
                        availableRepos.map(repo => `
                            <div class="repo-selector-item" data-owner="${repo.owner.login}" data-repo="${repo.name}">
                                <span>📦</span>
                                <div class="repo-info">
                                    <div class="repo-info-name">${repo.owner.login}/${repo.name}</div>
                                    <div class="repo-info-desc">${repo.description || '无描述'} · ${repo.private ? '私有' : '公开'}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="form-group">
                    <label>或手动输入仓库</label>
                    <input type="text" id="manual-repo" placeholder="owner/repo">
                </div>
            `;

            this.showModal(I18n.t('repo.associate'), body, `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" onclick="app.linkRepository()">关联</button>
            `);

            // 绑定选择
            let selectedRepo = null;
            document.querySelectorAll('.repo-selector-item').forEach(item => {
                item.addEventListener('click', () => {
                    document.querySelectorAll('.repo-selector-item').forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    selectedRepo = { owner: item.dataset.owner, repo: item.dataset.repo };
                    document.getElementById('manual-repo').value = `${selectedRepo.owner}/${selectedRepo.repo}`;
                });
            });
        } catch (e) {
            this.showToast('加载仓库列表失败: ' + e.message, 'error');
            this.closeModal();
        }
    }

    /**
     * 重命名模态框
     */
    showRenameModal(file) {
        this.showModal(
            '重命名',
            `
                <div class="form-group">
                    <label>新名称</label>
                    <input type="text" id="rename-input" value="${file.name}" autofocus>
                </div>
            `,
            `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" onclick="app.renameFile()">确定</button>
            `
        );
        setTimeout(() => {
            const input = document.getElementById('rename-input');
            if (input) {
                input.focus();
                input.select();
            }
        }, 100);
    }

    /**
     * 移动文件模态框
     */
    showMoveModal(files) {
        this._moveFiles = Array.isArray(files) ? files : [files];
        this._showFolderPicker('移动到...', 'move');
    }

    /**
     * 复制文件模态框
     */
    showCopyModal(files) {
        this._copyFiles = Array.isArray(files) ? files : [files];
        this._showFolderPicker('复制到...', 'copy');
    }

    /**
     * 文件夹选择器（移动/复制共用）
     */
    _showFolderPicker(title, action) {
        const folders = this._getFolderList();
        const foldersHtml = folders.length === 0
            ? '<p style="color:#9ca3af;text-align:center;padding:24px 0;">暂无子文件夹，选择根目录即可</p>'
            : folders.map(f => {
                const indent = f.depth * 16;
                return `<div class="folder-picker-item" style="padding-left:${12 + indent}px" onclick="ui.selectFolder('${action}','${f.relativePath}')">📁 ${f.name}</div>`;
            }).join('');
        this.showModal(
            title,
            `
                <div class="folder-picker">
                    <div class="folder-picker-item root" onclick="ui.selectFolder('${action}','')">🏠 根目录</div>
                    ${foldersHtml}
                </div>
            `,
            `<button class="btn-secondary" onclick="ui.closeModal()">取消</button>`
        );
    }

    _getFolderList() {
        const vfs = this.app.storage.getVFS();
        return Object.keys(vfs.folders || {})
            .map(path => {
                const relativePath = path.replace(/^\/drive_home\/?/, '');
                if (!relativePath) return null;
                const name = relativePath.split('/').pop();
                const depth = relativePath.split('/').length - 1;
                return { path, relativePath, name, depth };
            })
            .filter(Boolean)
            .sort((a, b) => a.path.localeCompare(b.path));
    }

    selectFolder(action, relativePath) {
        if (action === 'move') {
            this._moveTargetPath = relativePath;
            app.moveFile();
        } else if (action === 'copy') {
            this._copyTargetPath = relativePath;
            app.copyFile();
        }
    }

    /**
     * 分享模态框
     */
    showShareModal(files) {
        const fileNames = files.map(f => f.name).join(', ');
        this.showModal(
            I18n.t('share.title'),
            `
                <div class="form-group">
                    <label>分享名称（可选）</label>
                    <input type="text" id="share-name" placeholder="my-share" autofocus>
                    <p class="form-hint">将用于生成分享仓库名称和链接</p>
                </div>
                <div class="form-group">
                    <label>分享描述（可选）</label>
                    <input type="text" id="share-desc" placeholder="这些是我分享的文件">
                </div>
                <div class="form-group">
                    <label>要分享的文件（${files.length} 个）</label>
                    <div style="background:#f6f8fa;padding:12px;border-radius:6px;font-size:13px;max-height:120px;overflow-y:auto;">
                        ${files.map(f => `<div>📄 ${f.name}</div>`).join('')}
                    </div>
                </div>
                <div id="share-progress" class="upload-progress hidden"></div>
            `,
            `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" id="share-confirm-btn" onclick="app.shareFiles()">创建分享</button>
            `
        );
        this._shareFiles = files;
    }

    // ==================== 分享进度弹窗 ====================
    //
    // 之前用 toast 刷进度：一次分享要弹 5~10 条通知，
    // 每条 3 秒后消失，堆满右上角且看不出整体进度。
    // 改成专用弹窗：进度条 + 步骤列表，一目了然。

    /** 分享流程的步骤定义（与 share.js 的 onProgress 百分比对应） */
    get shareSteps() {
        return [
            { at: 0,  key: 'repo',    label: '创建分享仓库' },
            { at: 30, key: 'copy',    label: '复制分享文件' },
            { at: 70, key: 'upload',  label: '上传文件' },
            { at: 85, key: 'pages',   label: '启用 Pages' },
            { at: 100, key: 'done',   label: '完成' }
        ];
    }

    /** 打开分享进度弹窗 */
    showShareProgress(fileCount) {
        const steps = this.shareSteps;
        const body = `
            <div class="share-prog">
                <div class="sp-head">
                    <span class="sp-count">正在分享 ${fileCount} 个文件</span>
                    <span class="sp-pct" id="sp-pct">0%</span>
                </div>
                <div class="sp-bar"><div class="sp-bar-fill" id="sp-fill"></div></div>
                <ul class="sp-steps" id="sp-steps">
                    ${steps.map((s2, i) => `
                        <li class="sp-step" data-key="${s2.key}" id="sp-step-${s2.key}">
                            <span class="sp-ico"></span>
                            <span class="sp-label">${s2.label}</span>
                        </li>`).join('')}
                </ul>
                <div class="sp-note" id="sp-note">准备中…</div>
            </div>
        `;
        // 分享中不允许点遮罩关闭，避免流程中断后状态错乱
        this.showModal('分享文件', body, '');
        this._shareProgressOpen = true;
        this._markStep('repo', 'active');
    }

    /**
     * 更新进度
     * @param {number} percent 0-100
     * @param {string} msg 当前步骤描述
     */
    updateShareProgress(percent, msg) {
        if (!this._shareProgressOpen) return;
        const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));

        const fill = document.getElementById('sp-fill');
        const pctEl = document.getElementById('sp-pct');
        const note = document.getElementById('sp-note');
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (note) note.textContent = msg || '';

        // 按百分比推进步骤状态
        const steps = this.shareSteps;
        let curIdx = 0;
        for (let i = 0; i < steps.length; i++) if (pct >= steps[i].at) curIdx = i;
        for (let i = 0; i < steps.length; i++) {
            const st = i < curIdx ? 'done' : (i === curIdx ? 'active' : '');
            this._markStep(steps[i].key, st);
        }
    }

    _markStep(key, state) {
        const el = document.getElementById('sp-step-' + key);
        if (!el) return;
        el.className = 'sp-step' + (state ? ' ' + state : '');
        const ico = el.querySelector('.sp-ico');
        if (ico) {
            ico.innerHTML = state === 'done' ? '✓' : (state === 'active' ? '' : '');
        }
    }

    /** 关闭进度弹窗（成功或失败都要调，否则弹窗会一直挂着） */
    closeShareProgress() {
        this._shareProgressOpen = false;
        // closeModal 会清掉 modal-container，进度弹窗也在一起
        if (document.getElementById('sp-fill')) this.closeModal();
    }

    /** 按需加载并显示某个分享仓库的文件列表 */
    async loadShareFiles(repoName) {
        const card = document.querySelector(`.share-card`);
        const tag = event && event.target ? event.target : null;
        if (tag) { tag.disabled = true; tag.textContent = '加载中…'; }
        try {
            const files = await this.app.shareManager.getShareFiles(repoName);
            if (tag) {
                if (!files.length) { tag.textContent = '（无文件）'; return; }
                tag.outerHTML = files
                    .map(f => `<span class="share-file-tag">${f.name}</span>`)
                    .join('');
            }
        } catch (e) {
            if (tag) { tag.disabled = false; tag.textContent = '加载失败，重试'; }
            this.showToast('读取文件失败: ' + e.message, 'error');
        }
    }

    /**
     * 显示分享结果
     */
    showShareResult(result) {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=${encodeURIComponent(result.shareUrl)}`;
        this.showModal(
            '分享创建成功！',
            `
                <div class="share-result">
                    <div class="share-result-icon">🎉</div>
                    <p style="font-size:16px;font-weight:600;margin-bottom:8px;">分享链接已生成</p>
                    <div id="pages-status" style="color:#d4a72c;font-size:13px;margin-bottom:16px;">⏳ GitHub Pages 正在部署，通常 1-2 分钟生效...</div>
                    <div style="margin-bottom:16px;">
                        <img src="${qrUrl}" alt="分享二维码" style="width:160px;height:160px;border:1px solid #e5e7eb;border-radius:8px;display:block;margin:0 auto;">
                        <p style="font-size:12px;color:#9ca3af;margin-top:8px;text-align:center;">📱 手机扫码访问 · 电脑右键保存 / 手机长按保存</p>
                    </div>
                    <div class="share-link-box">
                        <input type="text" value="${result.shareUrl}" readonly id="share-url-input">
                        <button class="btn-secondary" onclick="ui.copyToClipboard('${result.shareUrl}')"><span data-i18n='btn.copy'>Copy</span></button>
                    </div>
                    <div style="margin-top:12px;">
                        <a href="${result.shareUrl}" target="_blank" class="btn-text" style="color:#0969da;">在新窗口打开 →</a>
                        <a href="${result.repoUrl}" target="_blank" class="btn-text" style="color:#0969da;"><span data-i18n='share.viewRepo'>View Repo →</span></a>
                    </div>
                </div>
            `,
            `<button class="btn-primary" onclick="ui.closeModal()">完成</button>`
        );
        this._monitorPages(result.shareUrl);
    }

    /**
     * 监测 GitHub Pages 是否生效（通过 status.js 探针）
     */
    _monitorPages(shareUrl) {
        this._pagesMonitorStopped = false;
        const probeUrl = shareUrl.replace(/\/$/, '') + '/status.js';
        const check = () => {
            if (this._pagesMonitorStopped) return;
            const script = document.createElement('script');
            script.src = probeUrl + '?t=' + Date.now();
            script.onload = () => {
                if (this._pagesMonitorStopped) return;
                const el = document.getElementById('pages-status');
                if (el) {
                    el.innerHTML = I18n.t('share.ready');
                    el.style.color = '#1a7f37';
                }
                this._pagesMonitorStopped = true;
            };
            script.onerror = () => {
                if (script.parentNode) script.parentNode.removeChild(script);
                if (!this._pagesMonitorStopped) setTimeout(check, 5000);
            };
            document.head.appendChild(script);
            setTimeout(() => { if (script.parentNode) script.parentNode.removeChild(script); }, 10000);
        };
        setTimeout(check, 3000);
    }

    /**
     * 分享管理界面
     */
    showShareList(shares, opts) {
        const container = document.getElementById('file-list');
        if (!container) return;
        const o = opts || {};

        if (o.loading && (!shares || shares.length === 0)) {
            container.className = 'share-list';
            container.innerHTML = `
                <div style="text-align:center;padding:60px 20px;color:#6b7280;">
                    <div class="spinner" style="margin:0 auto 16px;"></div>
                    <p>正在从 GitHub 读取分享仓库…</p>
                </div>
            `;
            return;
        }

        if (!shares || shares.length === 0) {
            container.className = 'share-list empty';
            container.innerHTML = `
                <div class="share-empty">
                    <div class="share-empty-icon">📤</div>
                    <p class="share-empty-title">还没有分享任何文件</p>
                    <p class="share-empty-desc">右键文件 → 分享，即可创建公开分享链接</p>
                </div>
            `;
            return;
        }

        // 获取当前用户信息（分享人）
        const user = this.app.storage.getUser();
        const avatar = user?.avatar_url || '';
        const username = user?.login || 'unknown';

        container.className = 'share-list';
        container.innerHTML = shares.map(share => {
            const d = new Date(share.createdAt);
            const dateStr = isNaN(d.getTime()) ? '' :
                `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const hasFiles = (share.files || []).length > 0;
            const filesHtml = hasFiles
                ? (share.files || []).map(f => `<span class="share-file-tag">${f.name}</span>`).join('')
                : `<button class="btn-text btn-sm" onclick="ui.loadShareFiles('${share.repoName}')">查看文件</button>`;
            const safeUrl = (share.shareUrl || '').replace(/'/g, "\\'");
            const id = share.id || share.repoName;
            const badge = share.fromRemote
                ? '<span class="share-badge" title="直接从你的 GitHub 账号读取，换设备也能看到">云端</span>'
                : '';
            const missing = share.missing
                ? '<span class="share-badge warn" title="仓库已不存在">仓库已删除</span>'
                : '';
            const sizeKb = share.size ? ` · ${(share.size/1024).toFixed(1)} MB` : '';
            return `
                <div class="share-card">
                    <div class="share-card-header" style="display:flex;gap:12px;align-items:flex-start;">
                        <img src="${avatar}" alt="${username}" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;">
                        <div style="flex:1;min-width:0;">
                            <div class="share-card-title" style="margin-bottom:4px;">${share.description || share.repoName || I18n.t('share.unnamed')} ${badge} ${missing}</div>
                            <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">@${username} · ${dateStr}${sizeKb}</div>
                            <div class="share-card-files">${filesHtml}</div>
                        </div>
                    </div>
                    <div class="share-card-link">
                        <input type="text" value="${share.shareUrl || ''}" readonly onclick="this.select()" title="点击选中">
                        <button class="btn-secondary btn-sm" onclick="ui.copyToClipboard('${safeUrl}')"><span data-i18n='btn.copy'>Copy</span></button>
                    </div>
                    <div class="share-card-actions">
                        <a href="${share.shareUrl}" target="_blank" class="btn-text"><span data-i18n='share.open'>🔗 Open Share</span></a>
                        <a href="${share.repoUrl}" target="_blank" class="btn-text"><span data-i18n='share.viewRepo'>📂 View Repo</span></a>
                        <button class="btn-text btn-danger" onclick="app.deleteShare('${id}')">🗑️ 删除</button>
                    </div>
                </div>
            `;
        }).join('');
        I18n.apply();
    }


    // 发现分享：加载状态
    showExploreLoading() {
        const container = document.getElementById('file-list');
        if (!container) return;
        container.className = 'explore-list';
        container.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:#6b7280;">
                <div class="spinner" style="margin:0 auto 16px;"></div>
                <p><span data-i18n='share.searching'>Searching public shares...</span></p>
            </div>
        `;
    }

    // 发现分享：渲染卡片列表
    renderExploreShares(shares, hasMore) {
        const container = document.getElementById('file-list');
        if (!container) return;
        container.className = 'explore-list';

        // 按 repoName 去重（分页加载可能重复）
        const seen = new Set();
        shares = (shares || []).filter(s => {
            if (seen.has(s.repoName)) return false;
            seen.add(s.repoName);
            return true;
        });

        if (!shares || shares.length === 0) {
            container.innerHTML = `
                <div style="text-align:center;padding:60px 20px;color:#6b7280;">
                    <div style="font-size:48px;margin-bottom:16px;">🔍</div>
                    <p style="font-size:16px;margin-bottom:8px;">暂无公开分享</p>
                    <p style="font-size:13px;">分享文件时会自动创建公开仓库，其他人可以在这里发现</p>
                </div>
            `;
            return;
        }

        const cardsHtml = shares.map(share => {
            const d = new Date(share.updatedAt || share.createdAt);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const desc = share.description ? share.description.substring(0, 100) + (share.description.length > 100 ? '...' : '') : '暂无简介';
            const filesPreview = (share.files || []).slice(0, 3).map(f => `<span class="share-file-tag">${f.name}</span>`).join('');
            const moreFiles = (share.files || []).length > 3 ? `<span class="share-file-tag">+${share.files.length - 3}</span>` : '';
            return `
                <div class="explore-card">
                    <div class="explore-card-header">
                        <img src="${share.avatar}" class="explore-avatar" alt="">
                        <div class="explore-card-info">
                            <div class="explore-card-title">${this.escapeHtml(share.name)}</div>
                            <div class="explore-card-author">@${share.author} · ${dateStr}</div>
                        </div>
                    </div>
                    <div class="explore-card-desc">${this.escapeHtml(desc)}</div>
                    <div class="explore-card-files">${filesPreview}${moreFiles}</div>
                    <div class="explore-card-actions">
                        <a href="${share.pagesUrl}" target="_blank" class="btn-primary btn-sm"><span data-i18n='share.open'>🔗 Open Share</span></a>
                        <a href="${share.repoUrl}" target="_blank" class="btn-secondary btn-sm">📂 仓库</a>
                        <span class="explore-file-count">📄 ${share.fileCount} 个文件</span>
                    </div>
                </div>
            `;
        }).join('');

        const loadMoreBtn = hasMore ? `
            <div style="grid-column:1/-1;text-align:center;padding:20px;">
                <button class="btn-secondary" onclick="app.loadMoreExploreShares()">加载更多</button>
            </div>
        ` : '';

        container.innerHTML = `
            <div style="grid-column:1/-1;padding:8px 4px;color:#6b7280;font-size:13px;">
                🌐 发现 ${shares.length} 个公开分享${hasMore ? '（点击加载更多）' : ''}
            </div>
            ${cardsHtml}
            ${loadMoreBtn}
        `;
    }

    // HTML 转义
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ==================== 插件广场 ====================
    showPluginLoading() {
        const container = document.getElementById('file-list');
        if (!container) return;
        container.className = 'plugin-market';
        container.innerHTML = `
            <div style="text-align:center;padding:60px 20px;color:#6b7280;">
                <div class="spinner" style="margin:0 auto 16px;"></div>
                <p><span data-i18n='plugin.loading'>Loading plugin market...</span></p>
            </div>
        `;
    }

    filterPlugins(type) {
        this._marketFilter = type;
        document.querySelectorAll('.plugin-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === type);
        });
        if (this._marketPlugins) {
            this.renderPluginMarket(this._marketPlugins, this._marketInstalled);
        }
    }

    async switchPluginSource(source) {
        this._pluginSourceTab = source;
        this._marketFilter = 'all';
        if (source === 'community') {
            // 加载第三方插件
            const container = document.getElementById('file-list');
            if (container) {
                container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#6b7280;"><div style="font-size:32px;margin-bottom:12px;">🔍</div>正在搜索全网插件...</div>';
            }
            try {
                const result = await this.app.searchCommunityPlugins();
                this._marketPlugins = result.plugins;
                this._marketInstalled = this.app.getInstalledPlugins();
                this.renderPluginMarket(result.plugins, this._marketInstalled);
            } catch (e) {
                if (container) {
                    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#dc2626;">' + I18n.t('plugin.searchFailed') + ': ' + e.message + '</div>';
                }
            }
        } else {
            // 加载官方插件
            this.app.showPluginMarket();
        }
    }

    installCommunityPlugin(pluginInfo) {
        // 安全警告
        const msg = '⚠️ 第三方插件安全警告\n\n' +
            '插件: ' + pluginInfo.name + '\n' +
            '作者: ' + pluginInfo.author + '\n' +
            '仓库: ' + pluginInfo.repoFullName + '\n\n' +
            '此插件来自第三方开发者，GitHub Drive 无法保证安全性。\n' +
            '插件可能访问你的文件、Token 和个人信息。\n\n' +
            I18n.t('plugin.confirmTrust');
        const confirmed = confirm(msg);
        if (confirmed) {
            this.app.installCommunityPlugin(pluginInfo);
        }
    }

    renderPluginIcon(icon) {
        if (!icon) return '🧩';
        // 图片URL或data URL用img标签
        if (typeof icon === 'string' && (icon.startsWith('http') || icon.startsWith('data:'))) {
            return '<img src="' + icon + '" style="width:100%;height:100%;object-fit:cover;border-radius:8px" alt="">';
        }
        return icon; // emoji或文本
    }

    renderPluginMarket(plugins, installed) {
        const container = document.getElementById('file-list');
        if (!container) return;
        container.className = 'plugin-market';

        // 来源 Tab（始终显示，即使列表为空）
        const sourceTab = this._pluginSourceTab || 'official';
        const tabsHtml = `
            <div style="grid-column:1/-1;display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid #e5e7eb;">
                <button class="plugin-source-btn ${sourceTab==='official'?'active':''}" onclick="ui.switchPluginSource('official')">${I18n.t("plugin.official")}</button>
                <button class="plugin-source-btn ${sourceTab==='community'?'active':''}" onclick="ui.switchPluginSource('community')">${I18n.t("plugin.community")}</button>
            </div>`;
        const filterTabs = sourceTab === 'official' ? `
            <div style="grid-column:1/-1;display:flex;gap:8px;margin-bottom:12px;">
                <button class="plugin-filter-btn active" data-filter="all" onclick="ui.filterPlugins('all')"><span data-i18n='plugin.all'>All</span></button>
                <button class="plugin-filter-btn" data-filter="plugin" onclick="ui.filterPlugins('plugin')"><span data-i18n='plugin.tools'>🧰 Tools</span></button>
                <button class="plugin-filter-btn" data-filter="game" onclick="ui.filterPlugins('game')"><span data-i18n='plugin.games'>🎮 Games</span></button>
            </div>` : '';

        if (!plugins || plugins.length === 0) {
            container.innerHTML = tabsHtml + filterTabs + `
                <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#6b7280;">
                    <div style="font-size:48px;margin-bottom:16px;">🧩</div>
                    <p style="font-size:16px;margin-bottom:8px;">${I18n.t("plugin.noPlugins")}</p>
                    <p style="font-size:13px;">访问插件仓库提交你的插件</p>
                </div>
            `;
            I18n.apply();
            return;
        }

        const installedCount = Object.keys(installed || {}).length;
        this._marketPlugins = plugins;
        this._marketInstalled = installed;
        this._marketFilter = 'all';

        // 后端服务状态卡片
        const backendConfig = this.app.getBackendConfig();
        const backendUrl = (backendConfig && backendConfig.url) || 'http://localhost:8787';
        // 默认显示未连接，异步测试成功后更新
        const backendConnected = false;
        // 异步测试后端实际连接状态
        this._testBackendConnection(backendUrl);
        const backendCard = `
            <div id="backend-service-card" class="plugin-card" style="border-color:${backendConnected ? '#16a34a' : '#f59e0b'};background:${backendConnected ? '#f0fdf4' : '#fffbeb'};">
                <div class="plugin-card-header">
                    <div class="plugin-icon" style="background:${backendConnected ? '#16a34a' : '#f59e0b'};color:#fff;">⚡</div>
                    <div class="plugin-card-info">
                        <div class="plugin-card-title"><span data-i18n='backend.cardTitle'>Backend Service</span> ${backendConnected ? '<span style="color:#16a34a;font-size:12px;">● ' + I18n.t('backend.connected') + '</span>' : '<span style="color:#d97706;font-size:12px;">● ' + I18n.t('backend.notConnected') + '</span>'}</div>
                        <div class="plugin-card-meta"><span data-i18n='backend.cardDesc'>Provides network, file ops, command execution for plugins</span></div>
                    </div>
                </div>
                <div class="plugin-card-desc">${backendConnected ? I18n.t('backend.runningDesc') : I18n.t('backend.notRunningDesc')}</div>
                <div class="plugin-card-actions">
                    ${backendConnected
                        ? `<button class="btn-secondary btn-sm" onclick="ui.showBackendSettings()">⚙️ 配置</button>`
                        : `<button class="btn-primary btn-sm" onclick="ui.downloadBackendAuto(true)"><span data-i18n='backend.fastDownload'>⚡ Fast Download</span></button>
                           <button class="btn-secondary btn-sm" onclick="ui.downloadBackendAuto(false)"><span data-i18n='backend.officialSource'>Official</span></button>
                           <button class="btn-secondary btn-sm" onclick="ui.showBackendSettings()">⚙️ 配置</button>`
                    }
                </div>
            </div>`;

        const filteredPlugins = this._marketFilter === 'all' ? plugins : plugins.filter(p => (p.type || 'plugin') === this._marketFilter);
        // 后端已连接时隐藏后端服务卡片
        const showBackendCard = !this._backendConnected;
        const cardsHtml = (showBackendCard ? backendCard : '') + filteredPlugins.map(p => {
            const isInstalled = !!(installed && installed[p.id]);
            const installAction = p.community
                ? `onclick="ui.installCommunityPlugin(${JSON.stringify(p).replace(/"/g, '&quot;')})"`
                : `onclick="app.installPlugin(${JSON.stringify(p).replace(/"/g, '&quot;')})"`;
            const actionBtn = isInstalled
                ? `<button class="btn-primary btn-sm" onclick="app.runPlugin('${p.id}')">▶️ 运行</button>
                   <button class="btn-secondary btn-sm" onclick="app.uninstallPlugin('${p.id}')">🗑️ 卸载</button>`
                : `<button class="btn-primary btn-sm" ${installAction}><span data-i18n='btn.install'>⬇️ Install</span></button>`;
            return `
                <div class="plugin-card">
                    <div class="plugin-card-header">
                        <div class="plugin-icon">${this.renderPluginIcon(p.icon)}</div>
                        <div class="plugin-card-info">
                            <div class="plugin-card-title">${this.escapeHtml(p.name)}</div>
                            <div class="plugin-card-meta">@${this.escapeHtml(p.author || 'unknown')} · v${p.version || '1.0.0'}</div>
                        </div>
                        ${isInstalled ? '<span class="plugin-badge">' + I18n.t('plugin.installed') + '</span>' : ''}
                        ${p.type === 'game' ? '<span class="plugin-badge" style="background:#f59e0b;">' + I18n.t('plugin.game') + '</span>' : ''}
                        ${p.community ? '<span class="plugin-badge" style="background:#8b5cf6;">' + I18n.t('plugin.communityTag') + '</span>' : ''}
                    </div>
                    <div class="plugin-card-desc">${this.escapeHtml(p.description || '')}</div>
                    <div class="plugin-card-actions">${actionBtn}</div>
                </div>
            `;
        }).join('');

        container.innerHTML = tabsHtml + filterTabs + `
            <div style="grid-column:1/-1;padding:8px 4px;color:#6b7280;font-size:13px;">
                🧩 <span data-i18n='plugin.market'>Plugin Market</span> · ${plugins.length} <span data-i18n='plugin.plugins'>plugins</span> · ${installedCount} <span data-i18n='plugin.installed'>installed</span>
            </div>
            ${cardsHtml}
        `;
        I18n.apply();
    }

    /**
     * 运行插件 —— 统一全屏显示
     *
     * 之前只有 type=game 或 fullscreen=true 的插件全屏，其余走
     * showModal + 70vh 的 iframe。那样有两个问题：
     *   ① 工具型插件（编辑器、预览器）在小窗口里很憋屈，
     *      尤其是代码编辑器、Markdown 预览这类需要横向空间的
     *   ② 两条路径的生命周期管理不一致：
     *      全屏用 _pluginRunners 字典按 id 存 messageHandler，
     *      弹窗却用 _pluginMessageHandler 单个变量 ——
     *      开两个插件时后开的会把前一个的 handler 覆盖掉，
     *      导致先开的插件再也收不到宿主响应，且关闭时泄漏监听。
     * 统一走全屏后 ② 自动消失。
     */
    showPluginRunner(plugin) {
        // 加随机后缀：同一毫秒内连开两个插件时，
        // 纯 Date.now() 会生成相同 id，后开的顶掉先开的记录
        const modalId = 'plugin-runner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

        // 外部 URL 插件：直接用 iframe 加载，无 blob 需要回收
        if (plugin.externalUrl) {
            this._mountPluginOverlay(modalId, plugin, plugin.externalUrl, null);
            return;
        }

        // 注入 I18n 支持，让插件可以使用 window.I18n.t() 做双语
        const i18nScript = `
<script>
window.I18n = {
    currentLang: '${I18n.current}',
    t: function(key) {
        // 插件自己的翻译优先，然后回退到主应用的翻译
        if (window.__pluginI18n && window.__pluginI18n[this.currentLang] && window.__pluginI18n[this.currentLang][key]) {
            return window.__pluginI18n[this.currentLang][key];
        }
        return key;
    },
    setPluginTranslations: function(translations) {
        window.__pluginI18n = translations;
    }
};
</script>`;
        const htmlWithI18n = plugin.html.replace('<head>', '<head>' + i18nScript).replace('<body>', i18nScript + '<body>');
        const finalHtml = htmlWithI18n === plugin.html ? i18nScript + plugin.html : htmlWithI18n;
        const blob = new Blob([finalHtml], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        this._mountPluginOverlay(modalId, plugin, url, url);
    }

    /**
     * 挂载全屏插件层（供 showPluginRunner 复用）
     * @param {string} modalId 唯一 id
     * @param {Object} plugin 插件信息
     * @param {string} src iframe 地址
     * @param {string|null} blobUrl blob 地址（关闭时需 revoke，外部 URL 传 null）
     */
    _mountPluginOverlay(modalId, plugin, src, blobUrl) {
        const isGame = plugin.type === 'game';
        // 图标优先用插件自带的，其次按类型兜底
        const icon = plugin.icon || (isGame ? '🎮' : '🔌');

        // 锁定页面滚动：全屏覆盖时背景不该跟着滚。
        // 只在第一个插件层打开时记录原值，避免多层嵌套时恢复到错误状态。
        this._pluginRunners = this._pluginRunners || {};
        if (Object.keys(this._pluginRunners).length === 0) {
            this._prevBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
        }

        const overlay = document.createElement('div');
        overlay.id = modalId;
        overlay.className = 'plugin-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#000;display:flex;flex-direction:column;';
        overlay.innerHTML = `
            <div class="plugin-bar">
                <span class="plugin-bar-title">
                    <span class="plugin-bar-icon">${this.escapeHtml(icon)}</span>
                    ${this.escapeHtml(plugin.name)}
                    <span class="plugin-bar-ver">${this.escapeHtml(plugin.version || '')}</span>
                </span>
                <span class="plugin-bar-actions">
                    <button class="plugin-btn" onclick="ui.closePluginRunner('${modalId}','${blobUrl || ''}')">✕ 关闭</button>
                </span>
            </div>
            <iframe class="plugin-frame" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
        `;
        document.body.appendChild(overlay);

        // 每个插件层独立持有 handler，互不覆盖
        const messageHandler = (event) => {
            if (event.data && event.data.type === 'gd-api') {
                this.app.handlePluginMessage(event, plugin.id);
            }
        };
        window.addEventListener('message', messageHandler);

        // ESC 关闭：全屏层最自然的退出方式
        const keyHandler = (e) => {
            if (e.key === 'Escape') this.closePluginRunner(modalId, blobUrl || '');
        };
        document.addEventListener('keydown', keyHandler);

        this._pluginRunners[modalId] = { url: blobUrl, messageHandler, keyHandler };
    }

    /**
     * 关闭插件层
     * @param {string} modalId
     * @param {string} url blob 地址（可空；外部 URL 插件没有）
     */
    closePluginRunner(modalId, url) {
        const overlay = document.getElementById(modalId);
        if (overlay) overlay.remove();

        const rec = this._pluginRunners && this._pluginRunners[modalId];
        if (rec) {
            window.removeEventListener('message', rec.messageHandler);
            document.removeEventListener('keydown', rec.keyHandler);
            delete this._pluginRunners[modalId];
        }

        // blob URL 在所有路径下都要回收，否则内存泄漏
        const blobUrl = url || (rec && rec.url);
        if (blobUrl) URL.revokeObjectURL(blobUrl);

        // 所有插件层都关完了才恢复滚动
        if (this._pluginRunners && Object.keys(this._pluginRunners).length === 0) {
            document.body.style.overflow = this._prevBodyOverflow || '';
            this._prevBodyOverflow = null;
        }

        // 兼容旧调用：可能还残留着弹窗版的状态
        if (this._pluginMessageHandler) {
            window.removeEventListener('message', this._pluginMessageHandler);
            this._pluginMessageHandler = null;
        }
        this._pluginRunnerUrl = null;
        this.closeModal();
    }

    // ==================== 统一上传弹窗 ====================
    
    _uploadFiles = [];
    
    openUploadModal() {
        this._uploadFiles = [];
        this.renderUploadFileList();
        document.getElementById('upload-modal').classList.remove('hidden');
    }
    
    closeUploadModal() {
        document.getElementById('upload-modal').classList.add('hidden');
        this._uploadFiles = [];
    }
    
    addUploadFiles(files) {
        if (!files || files.length === 0) return;
        for (const file of files) {
            if (!this._uploadFiles.find(f => f.name === file.name && f.size === file.size)) {
                this._uploadFiles.push(file);
            }
        }
        this.renderUploadFileList();
    }
    
    removeUploadFile(index) {
        this._uploadFiles.splice(index, 1);
        this.renderUploadFileList();
    }
    
    clearUploadFiles() {
        this._uploadFiles = [];
        this.renderUploadFileList();
    }
    
    renderUploadFileList() {
        const list = document.getElementById('upload-file-list');
        const count = document.getElementById('upload-file-count');
        const confirmBtn = document.getElementById('upload-confirm-btn');
        if (!list) return;
        if (count) count.textContent = this._uploadFiles.length;
        if (confirmBtn) confirmBtn.disabled = this._uploadFiles.length === 0;
        if (this._uploadFiles.length === 0) {
            list.innerHTML = '<div class="upload-file-empty">还没有选择文件</div>';
            return;
        }
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };
        list.innerHTML = this._uploadFiles.map((file, i) => {
            const isFolder = file.webkitRelativePath && file.webkitRelativePath.includes('/');
            const icon = isFolder ? '📁' : '📄';
            const displayName = isFolder ? file.webkitRelativePath : file.name;
            return `<div class="upload-file-item"><span class="upload-file-item-icon">${icon}</span><span class="upload-file-item-name" title="${displayName}">${displayName}</span><span class="upload-file-item-size">${formatSize(file.size)}</span><button class="upload-file-item-remove" onclick="ui.removeUploadFile(${i})">✕</button></div>`;
        }).join('');
    }
    
    async confirmUpload() {
        if (this._uploadFiles.length === 0) return;
        // 先保存文件数组，再关闭弹窗（closeUploadModal 会清空 _uploadFiles）
        const files = [...this._uploadFiles];
        this.closeUploadModal();
        const hasFolder = files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
        if (hasFolder) {
            await this.app.uploadFolder(files);
        } else {
            await this.app.uploadFiles(files);
        }
    }
    
    async readDirectoryEntry(entry, path = '') {
        const files = [];
        if (entry.isFile) {
            return new Promise(resolve => {
                entry.file(file => {
                    if (path) Object.defineProperty(file, 'webkitRelativePath', { value: path + '/' + file.name });
                    resolve([file]);
                });
            });
        }
        if (entry.isDirectory) {
            const reader = entry.createReader();
            const entries = await new Promise(resolve => reader.readEntries(resolve));
            for (const e of entries) {
                const subFiles = await this.readDirectoryEntry(e, path ? path + '/' + entry.name : entry.name);
                files.push(...subFiles);
            }
        }
        return files;
    }

    /**
     * 上传进度弹窗
     */
    showUploadProgress(files) {
        // 移除已有弹窗
        const existing = document.getElementById('upload-progress-modal');
        if (existing) existing.remove();

        const fileList = Array.isArray(files) ? files : [files];
        const filesHtml = fileList.map((f, i) => {
            const name = f.name || f.webkitRelativePath || '文件';
            return `
            <div class="upload-item" id="upload-item-${i}">
                <div class="upload-item-name">
                    <span class="file-name">📄 ${name}</span>
                    <span id="upload-percent-${i}">0%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-bar-fill" id="upload-bar-${i}" style="width:0%"></div>
                </div>
            </div>`;
        }).join('');

        const modal = document.createElement('div');
        modal.id = 'upload-progress-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:480px;width:90vw;">
                <div class="modal-header">
                    <h3>📤 正在上传（${fileList.length} 个文件）</h3>
                </div>
                <div class="modal-body" style="max-height:400px;overflow-y:auto;">
                    ${filesHtml}
                </div>
                <div class="modal-footer">
                    <span id="upload-overall-progress" style="font-size:13px;color:#6b7280;">总进度：0%</span>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        this._uploadTotalFiles = fileList.length;
        this._uploadCompletedFiles = 0;
        this._uploadPercents = {};
    }

    updateUploadProgress(index, percent) {
        const bar = document.getElementById(`upload-bar-${index}`);
        const percentEl = document.getElementById(`upload-percent-${index}`);
        if (bar) bar.style.width = percent + '%';
        if (percentEl) percentEl.textContent = percent + '%';
        
        // 实时更新总进度：所有文件进度的平均值
        if (!this._uploadPercents) this._uploadPercents = {};
        this._uploadPercents[index] = percent;
        const total = this._uploadTotalFiles || 1;
        let sum = 0;
        for (let i = 0; i < total; i++) {
            sum += this._uploadPercents[i] || 0;
        }
        const overall = Math.round(sum / total);
        const overallEl = document.getElementById('upload-overall-progress');
        if (overallEl) overallEl.textContent = `总进度：${overall}%`;
    }

    setUploadSuccess(index) {
        const item = document.getElementById(`upload-item-${index}`);
        const percentEl = document.getElementById(`upload-percent-${index}`);
        const bar = document.getElementById(`upload-bar-${index}`);
        if (item) item.classList.add('success');
        if (bar) bar.style.width = '100%';
        if (percentEl) percentEl.textContent = I18n.t('common.done');
        // 更新总进度
        this._uploadCompletedFiles = (this._uploadCompletedFiles || 0) + 1;
        const total = this._uploadTotalFiles || 1;
        const overall = Math.round((this._uploadCompletedFiles / total) * 100);
        const overallEl = document.getElementById('upload-overall-progress');
        if (overallEl) overallEl.textContent = `总进度：${overall}%（${this._uploadCompletedFiles}/${total}）`;
    }

    hideUploadProgress() {
        const modal = document.getElementById('upload-progress-modal');
        if (!modal) return;
        modal.classList.add('closing');
        setTimeout(() => modal.remove(), 300);
    }
    
    // 显示下载进度
    showDownloadProgress(fileName) {
        const existing = document.getElementById('download-progress-modal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.id = 'download-progress-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal" style="max-width:420px;width:90vw;">
                <div class="modal-header">
                    <h3>⬇️ 正在下载</h3>
                </div>
                <div class="modal-body">
                    <div class="upload-item">
                        <div class="upload-item-name">
                            <span class="file-name">📄 ${fileName}</span>
                            <span id="download-percent">0%</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-bar-fill" id="download-bar" style="width:0%"></div>
                        </div>
                    </div>
                    <p id="download-chunk-info" style="font-size:12px;color:#6b7280;margin-top:8px;text-align:center;">准备下载...</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    updateDownloadProgress(percent, current, total) {
        const bar = document.getElementById('download-bar');
        const percentEl = document.getElementById('download-percent');
        const chunkInfo = document.getElementById('download-chunk-info');
        if (bar) bar.style.width = percent + '%';
        if (percentEl) percentEl.textContent = percent + '%';
        if (chunkInfo) chunkInfo.textContent = `分片 ${current}/${total}`;
    }
    
    hideDownloadProgress() {
        const modal = document.getElementById('download-progress-modal');
        if (!modal) return;
        modal.classList.add('closing');
        setTimeout(() => modal.remove(), 300);
    }

    // 异步测试后端连接状态
    async _testBackendConnection(url) {
        const config = this.app.getBackendConfig();
        const token = config.token || '';
        const headers = {};
        if (token) headers['X-Auth-Token'] = token;
        
        // 同时尝试配置的 URL 和 127.0.0.1（解决 localhost 解析到 IPv6 的问题）
        const urls = [url];
        if (url.includes('localhost')) {
            urls.push(url.replace('localhost', '127.0.0.1'));
        }
        
        for (const testUrl of urls) {
            try {
                const resp = await fetch(testUrl + '/health', { 
                    signal: AbortSignal.timeout(5000),
                    headers
                });
                if (resp.ok) {
                    // 更新后端卡片显示为已连接
                    const card = document.getElementById('backend-service-card');
                    if (card) {
                        card.style.borderColor = '#16a34a';
                        card.style.background = '#f0fdf4';
                        const title = card.querySelector('.plugin-card-title');
                        if (title) title.innerHTML = '后端服务 <span style="color:#16a34a;font-size:12px;">● 已连接</span>';
                        const desc = card.querySelector('.plugin-card-desc');
                        if (desc) desc.textContent = '后端服务运行正常，所有插件功能可用。';
                        // 已连接时隐藏下载按钮，只保留配置
                        const actions = card.querySelector('.plugin-card-actions');
                        if (actions) actions.innerHTML = '<button class="btn-secondary btn-sm" onclick="ui.showBackendSettings()"><span data-i18n=\'backend.config\'>⚙️ Config</span></button>';
                    }
                    this._backendConnected = true;
                    // 如果用的是 127.0.0.1 成功，更新配置
                    if (testUrl !== url && testUrl.includes('127.0.0.1')) {
                        config.url = testUrl;
                        this.app.saveBackendConfig(config);
                    }
                    return;
                }
            } catch (e) {
                // 继续尝试下一个 URL
            }
        }
        this._backendConnected = false;
    }

    // ==================== Toast 通知 ====================

    showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">×</button>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            toast.style.transition = 'all 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ==================== 工具方法 ====================

    copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            this.showToast(I18n.t('toast.copied'), 'success');
        }).catch(() => {
            // 降级方案
            const input = document.createElement('input');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            this.showToast(I18n.t('toast.copied'), 'success');
        });
    }

    /**
     * 显示确认对话框
     */
    showConfirm(title, message, onConfirm) {
        this.showModal(
            title,
            `<p style="font-size:14px;color:#1f2328;">${message}</p>`,
            `
                <button class="btn-secondary" onclick="ui.closeModal()">取消</button>
                <button class="btn-primary" style="background:#cf222e;" onclick="ui.closeModal();(${onConfirm.toString()})()">确定</button>
            `
        );
    }
}
