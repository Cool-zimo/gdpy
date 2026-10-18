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
            // ★ 顶栏常驻后搜索框在任何视图都能输入，
            //   但搜索结果只存在于文件视图 —— 自动切回去，别让人以为坏了。
            if (this.app && this.app._currentView && this.app._currentView !== 'all-files') {
                this.switchView('all-files');
            }
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
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isMobile()) this.toggleMobileMenu();
                else toggleSidebar();
            });
            sidebarOverlay.addEventListener('click', () => toggleSidebar(false));
            document.querySelectorAll('.sidebar .nav-item').forEach(item => {
                item.addEventListener('click', () => {
                    if (isMobile()) {
                        // 移动端：侧边栏是"更多"面板，选完就收起
                        this.toggleMobileMenu(false);
                    }
                });
            });
            
            // 恢复电脑端折叠状态
            if (!isMobile() && localStorage.getItem('gd_sidebar_collapsed') === 'true') {
                sidebar.classList.add('collapsed');
                if (mainContent) mainContent.classList.add('sidebar-collapsed');
            }
        }

        // 恢复侧边栏分组折叠状态
        this.restoreNavGroups();

        // 兼容性自检：CSS 缓存版本 + CSS/HTML 的 API 版本（见 app.checkCompatibility）
        setTimeout(() => { try { this.app.checkCompatibility?.(); } catch (e) {} }, 1200);

        // 任务变化时更新"后台进程"角标
        window.addEventListener('gd:tasks-changed', () => this.updateTaskBadge());
        this.updateTaskBadge();

        // 插件增减时，后台进程里的预览卡要立刻跟着变（不用等 700ms 那轮）
        window.addEventListener('gd:plugin-changed', () => {
            if (this.app?._currentView === 'tasks') this._renderPluginStages();
        });

        // 插件入口在移动端也保留：插件跑的是仓库里的 html 或外部 URL，
        // 不依赖本地后端，手机能跑（只是不飘小窗，改去「后台进程」里看预览）。

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
        // 离开后台进程视图时停掉刷新定时器（否则它每 700ms 空转一整天）
        if (this.app._currentView === 'tasks' && view !== 'tasks') this._stopTasksRefresh();
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

        // ★ 顶栏全局常驻：不再随视图隐藏。
        //   以前非文件视图会整排 display:none，切到后台进程/设置时
        //   上边栏凭空消失，界面像换了个应用。现在只按视图切换可用态。
        if (toolbarActions) toolbarActions.style.display = '';
        this._syncToolbarForView(view);

        if (view === 'all-files') {
            // 恢复文件浏览器界面
            if (breadcrumb) breadcrumb.style.display = '';
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
            // 仪表盘视图：隐藏面包屑，但显示文件区域
            if (breadcrumb) breadcrumb.style.display = 'none';
            if (fileList) fileList.style.display = '';
            if (emptyState) emptyState.classList.add('hidden');
            if (loadingState) loadingState.classList.add('hidden');
            this.app.showDashboard();
        } else {
            // 非文件视图：隐藏面包屑和文件区域
            if (breadcrumb) breadcrumb.style.display = 'none';
            if (fileList) fileList.style.display = 'none';
            if (emptyState) emptyState.classList.add('hidden');
            if (loadingState) loadingState.classList.add('hidden');
            
            if (view === 'recent') {
                this.app.showRecentFiles();
            } else if (view === 'starred') {
                this.app.showStarredFiles();
            } else if (view === 'trash') {
                this.app.showTrashFiles();
            } else if (view === 'settings') {
                // ★ 设置：占主窗口，不弹窗
                //   这三个视图都是把列表渲染进 #file-list 的，
                //   而上面刚把它 display:none 了 —— 必须先还原，
                //   否则"有 8 个最近文件却一个不显示"。
                if (fileList) fileList.style.display = '';
                if (emptyState) emptyState.classList.add('hidden');
                if (loadingState) loadingState.classList.add('hidden');
                this._renderSettingsView();
            } else if (view === 'shared') {
                this.app.showShares();
            } else if (view === 'explore') {
                this.app.showExploreShares();
            } else if (view === 'tasks') {
                // 后台进程：占主窗口，不弹窗
                if (fileList) fileList.style.display = '';
                if (breadcrumb) breadcrumb.style.display = 'none';
                if (emptyState) emptyState.classList.add('hidden');
                if (loadingState) loadingState.classList.add('hidden');
                this._renderTasksView();
                this._startTasksRefresh();
                // 先渲染出落点，再让小窗飞过来
                if (typeof TaskDock !== 'undefined' && TaskDock.flyToList) {
                    requestAnimationFrame(() => TaskDock.flyToList());
                }
            } else if (view === 'plugins') {
                // ★ 移动端不加载插件：下载不了后端代码，点了只会白屏
                if (this.isPluginsBlocked && this.isPluginsBlocked()) {
                    this.showToast?.('插件在移动端不可用（无法下载插件后端）', 'info');
                    return;
                }
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
            // ★ 折叠项 path 是 null —— 不可点击
            //   不做这个判断的话 data-path 会变成字符串 "null"，
            //   点击后 setCurrentPath('null') → 跳到一个不存在的路径。
            const clickable = crumb.path !== null && crumb.path !== undefined;
            const attrs = clickable ? ' data-path="' + crumb.path + '"' : '';
            return `
                <span class="breadcrumb-item ${isLast ? 'current' : ''} ${clickable ? '' : 'breadcrumb-collapsed'}"${attrs}>
                    ${crumb.isRepo ? '📦 ' : ''}${crumb.name}
                </span>
                ${!isLast ? '<span class="breadcrumb-separator">/</span>' : ''}
            `;
        }).join('');

        // 绑定点击和拖放
        container.querySelectorAll('.breadcrumb-item').forEach(item => {
            // ★ 折叠项没有 data-path，跳过
            if (!item.dataset.path) return;
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

        // ★ 渲染前必须自己还原可见性。
        //   switchView 对"非文件视图"写过 container.style.display='none'
        //   （内联样式优先级高于 CSS 类，只改 className 救不回来）。
        //   而"最近使用 / 收藏 / 回收站"全都是渲染进这个容器的 ——
        //   于是出现"明明有 8 个最近文件，点进去一个都不显示"。
        //   由渲染方自己保证可见，比让每个调用方记得还原更可靠。
        if (container) container.style.display = '';

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

    /**
     * 设置面板（分组版）
     *
     * ★ 为什么渲染在主窗口而不是弹窗：
     *   ① 弹窗宽度受限，15 个条目要滚半天
     *   ② 弹窗里点开二级面板（仓库管理/自动整理）会叠成两层，关掉后容易迷路
     *   ③ 主窗口可以用「视图」的方式缓存滚动位置，来回切换不丢
     *
     * ★ 之前是 15 项平铺一列 —— 找一个"校准用量"要滚半天，
     *   而且"登出"这种破坏性操作和"暗色模式"挨在一起，容易误点。
     *   现在按语义分成四组，破坏性操作单独放最后。
     */
    showSettings() {
        // 入口在侧边栏底部按钮，走视图切换 → 主窗口渲染
        this.switchView('settings');
    }

    _settingsGroups() {
        var versionEl = document.getElementById('app-version');
        var version = versionEl ? versionEl.textContent : 'v-';

        const GROUPS = [
            {
                title: '外观',
                items: [
                    {icon:'🌙', title:I18n.t('settings.darkMode') || '暗色模式', desc:I18n.t('settings.darkModeDesc') || '切换深色/浅色主题', action:'ui.toggleDarkMode();'},
                    {icon:'🌐', title:I18n.t('settings.language'), desc:I18n.t('settings.languageDesc'), action:'I18n.toggle();ui.closeModal();'},
                    {icon:'🎨', title:'界面自定义', desc:'侧边栏/顶栏右键可勾选显示项，这里调主题与字号',
                     action:'ui.closeModal();ui.showLookPanel();'},
                    {icon:'🔗', title:'仓鼠联动', desc:'默认关闭 · 打开后登录页才会出现「沿用仓鼠账号」',
                     action:'ui.toggleBridge();',
                     extra:(localStorage.getItem('gd_bridge_enabled') === '1' ? '开' : '关')},
                ]
            },
            {
                title: '存储与仓库',
                items: [
                    {icon:'🗂️', title:'存储仓库管理', desc:'逐仓用量、新建仓库、校准容量登记、整理合并', action:'ui.closeModal();ui.showStorageManager();'},
                    {icon:'🤖', title:'自动整理设置', desc:'后台自动填满仓库、删除腾空的仓', action:'ui.closeModal();ui.showAutoCompactSettings();'},
                ]
            },
            {
                title: '功能',
                items: [
                    {icon:'🔍', title:I18n.t('settings.contentSearch') || '内容搜索', desc:I18n.t('settings.contentSearchDesc') || '搜索时同时匹配文件内容', action:'ui.toggleContentSearch();',
                     extra:(localStorage.getItem('gd_search_content') === '1' ? '开' : '关')},
                    {icon:'🎯', title:'智能分类', desc:'按文件类型自动整理到文件夹', action:'ui.closeModal();app.showCategoryStats();'},
                    {icon:'⚙️', title:I18n.t('settings.backend'), desc:I18n.t('settings.backendDesc'), action:'ui.closeModal();ui.showBackendManager();'},
                ]
            },
            {
                title: '关于与账号',
                items: [
                    {icon:'❓', title:I18n.t('settings.help'), desc:I18n.t('settings.helpDesc'), action:'ui.closeModal();ui.showHelp();'},
                    {icon:'🔀', title:I18n.t('settings.versionSwitch') || '版本切换', desc:I18n.t('settings.versionSwitchDesc') || '体验他人改进的版本', action:'ui.closeModal();ui.showVersionSwitcher();'},
                    {icon:'💾', title:I18n.t('settings.export'), desc:I18n.t('settings.exportDesc'), action:'app.exportBackup();ui.closeModal();'},
                    {icon:'🏷️', title:I18n.t('settings.version'), desc:'GitHub Drive', extra:version},
                    {icon:'🚪', title:I18n.t('settings.logout'), desc:I18n.t('settings.logoutDesc'), action:"if(confirm(I18n.t('settings.logoutConfirm'))){app.logout();ui.closeModal();}", danger:true}
                ]
            }
        ];

        let body = '';
        for (const g of GROUPS) {
            body += '<div style="margin-bottom:14px;">'
                  +   '<div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:0.5px;'
                  +   'text-transform:uppercase;padding:0 4px 6px;">' + g.title + '</div>';
            for (const it of g.items) {
                const extraHtml = it.extra ? ' <span style="font-weight:400;font-size:13px;color:#6b7280;">' + it.extra + '</span>' : '';
                const color = it.danger ? 'color:#dc2626;' : '';
                const hoverBg = it.danger ? 'var(--danger-light, #fef2f2)' : 'var(--bg-hover, #f3f4f6)';
                body += '<div onclick="' + (it.action || '') + '" style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:8px;cursor:pointer;margin-bottom:6px;' + color + '" onmouseover="this.style.background=\"' + hoverBg + '\"" onmouseout="this.style.background=\"transparent\"">';
                body += '<span style="font-size:20px;">' + it.icon + '</span>';
                body += '<div><div style="font-weight:600;font-size:14px;color:var(--text-primary);">' + it.title + extraHtml + '</div><div style="font-size:12px;color:var(--text-secondary);">' + it.desc + '</div></div></div>';
            }
            body += '</div>';
        }
        return body;
    }

    /**
     * 设置页渲染到主窗口
     *
     * ★ 必须清掉 switchView 写的内联 display:none ——
     *   内联样式优先级高于 CSS 类，只改 className 不管用
     *   （"我的分享""最近使用"列表空白都是同一个原因）。
     */
    /**
     * 🔗 仓鼠联动开关（默认关闭）
     *
     * ★ 为什么默认关：跨应用联动会在登录页多出一整块提示区，
     *   多数情况下用不到，反而把登录页挤乱。
     *   关掉时连 Bridge 都不去读 —— 不只是隐藏显示。
     */
    toggleBridge() {
        const cur = localStorage.getItem('gd_bridge_enabled') === '1';
        const next = !cur;
        localStorage.setItem('gd_bridge_enabled', next ? '1' : '0');
        this.showToast?.(next ? '已开启仓鼠联动，刷新登录页后生效' : '已关闭仓鼠联动', 'info');
        if (this.app?._currentView === 'settings') this._renderSettingsView();
    }

    /** 外观面板：从设置项点进来时直接滚到自定义控件 */
    showLookPanel() {
        this.switchView('settings');
        setTimeout(function () {
            var host = document.getElementById('gd-look-host');
            if (host && host.scrollIntoView) host.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
    }

    _renderSettingsView() {
        const fileList = document.getElementById('file-list');
        if (!fileList) return;
        fileList.style.display = '';
        fileList.className = 'settings-view';
        fileList.innerHTML =
            '<div style="max-width:760px;margin:0 auto;">'
          +   '<h2 style="font-size:20px;font-weight:700;margin:0 0 4px;color:var(--text-primary);">'
          +   (I18n.t('settings.title') || '设置').replace(/^[\u2190-\uFFEF\u2600-\u27BF\s]+/, '') + '</h2>'
          +   '<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:18px;">'
          +   (I18n.t('settings.groupedHint', '设置项已按用途分组')) + '</div>'
          +   this._settingsGroups()
          + '</div>';
        // 外观控件由 GdCustom 提供；模块没加载就跳过，不能让设置页开不了
        try {
            if (window.GdCustom && window.GdCustom.bindLook) {
                var host = document.createElement('div');
                host.id = 'gd-look-host';
                host.innerHTML = window.GdCustom.lookSectionHtml();
                var wrap = fileList.firstChild;
                if (wrap) wrap.appendChild(host);
                window.GdCustom.bindLook(host);
            }
        } catch (e) { /* 设置页不能因为外观控件挂掉 */ }
    }

    /**
     * 内容搜索开关
     *
     * ★ 这个方法之前根本不存在 —— 设置里那条写着 action:'ui.toggleContentSearch();'，
     *   点下去抛 ReferenceError，界面上就是"点了没反应"。
     *   而且就算实现了开关，fileManager.searchFiles 也把第二个参数丢了，
     *   所以这里连同真正的开关状态一起修。
     */
    toggleContentSearch() {
        const cur = localStorage.getItem('gd_search_content') === '1';
        const next = !cur;
        localStorage.setItem('gd_search_content', next ? '1' : '0');
        this.showToast?.(
            next ? '内容搜索已开启：搜索时也会匹配文本文件内容（更慢）'
                 : '内容搜索已关闭：只匹配文件名',
            next ? 'success' : 'info');
        // 就地刷新，让"开/关"状态立刻变
        if (this.app?._currentView === 'settings') this._renderSettingsView();
    }


    /**
     * 自动整理设置
     *
     * 默认行为说明要写清楚：**只迁移，不删仓**。
     * 迁移是可控的（数据还在源仓），删仓不可逆 ——
     * 后台默默删仓库这件事，默认开太危险了。
     */
    showAutoCompactSettings() {
        const cfg = (this.app && this.app.storage && this.app.storage.getStorageConfig()) || {};
        const on = cfg.autoCompact !== false;
        const del = cfg.autoCompactDelete === true;
        const maxMB = cfg.autoCompactMaxMoveMB || 300;
        const coolH = cfg.autoCompactCooldownHours || 24;

        let last = '从未运行';
        if (cfg.lastAutoCompactAt) {
            const h = Math.floor((Date.now() - cfg.lastAutoCompactAt) / 3600000);
            last = h < 1 ? '刚刚' : (h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`);
        }

        const row = (label, desc, ctl) =>
            `<div style="padding:12px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <div style="flex:1;min-width:200px;">
                        <div style="font-size:13px;font-weight:600;color:#1f2937;">${label}</div>
                        <div style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:2px;">${desc}</div>
                    </div>
                    ${ctl}
                </div>
             </div>`;

        const toggle = (act, cur, onT, offT) =>
            `<button onclick="ui.toggleAutoCompact('${act}')"
                style="min-width:64px;padding:6px 12px;border-radius:999px;border:1px solid #d1d5db;
                       background:${cur ? '#2563eb' : '#f3f4f6'};color:${cur ? '#fff' : '#6b7280'};
                       font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">
                ${cur ? onT : offT}</button>`;

        const body = `
        <div style="padding:8px 0;font-size:13px;line-height:1.7;">
            <div style="padding:12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;margin-bottom:12px;font-size:12px;color:#1e40af;line-height:1.6;">
                <b>整理方式：填满大仓 → 删除腾空的仓</b><br>
                <span style="color:#1e3a8a;">
                按分片搬运，把排在前面的仓尽量塞到 900 MB，
                剩下的往后堆，最后把<b>归零的仓删掉</b>。<br>
                删空仓会少一份额度，但空仓随时能自动重建，不影响使用。
                </span>
            </div>

            ${row('自动整理', '满足条件时后台自动执行', toggle('autoCompact', on, '已开启', '已关闭'))}
            ${row('自动删除腾空的仓', '迁移完成后把空仓删掉（<b>不可恢复</b>）', toggle('autoCompactDelete', del, '会删除', '保留'))}
            ${row('单次迁移上限', `超过这个量就不在后台默默搬（当前 ${maxMB} MB）`,
                `<input id="ac-maxmb" type="number" value="${maxMB}" min="10" max="2000" step="50"
                    style="width:84px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
                 <span style="font-size:12px;color:#9ca3af;">MB</span>`)}
            ${row('冷却时间', `两次整理之间至少间隔（当前 ${coolH} 小时）`,
                `<input id="ac-coolh" type="number" value="${coolH}" min="1" max="720" step="1"
                    style="width:84px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
                 <span style="font-size:12px;color:#9ca3af;">小时</span>`)}

            <div style="font-size:12px;color:#9ca3af;margin:10px 0;">
                上次整理：${last}
            </div>

            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn-primary btn-sm" onclick="ui.saveAutoCompact()">保存并立即评估</button>
                <button class="btn-secondary btn-sm" onclick="ui.closeModal();ui.showStorageManager();">手动整理</button>
            </div>
        </div>`;
        this.showModal('🤖 自动整理设置', body, '', true);
    }

    /** 切换自动整理的某个开关 */
    toggleAutoCompact(key) {
        if (!this.app || !this.app.storage) return;
        const cfg = this.app.storage.getStorageConfig() || {};
        if (key === 'autoCompact') cfg.autoCompact = cfg.autoCompact === false;
        if (key === 'autoCompactDelete') cfg.autoCompactDelete = cfg.autoCompactDelete !== true;
        this.app.storage.updateStorageConfig?.(cfg);
        this.app.configSync?.scheduleSync?.();
        this.showAutoCompactSettings();
    }

    /** 保存数值设置，并立刻评估一次 */
    saveAutoCompact() {
        if (!this.app || !this.app.storage) return;
        const cfg = this.app.storage.getStorageConfig() || {};
        const mb = parseInt((document.getElementById('ac-maxmb') || {}).value, 10);
        const ch = parseInt((document.getElementById('ac-coolh') || {}).value, 10);
        if (mb >= 10 && mb <= 2000) cfg.autoCompactMaxMoveMB = mb;
        if (ch >= 1 && ch <= 720) cfg.autoCompactCooldownHours = ch;
        this.app.storage.updateStorageConfig?.(cfg);
        this.app.configSync?.scheduleSync?.();
        this.closeModal();
        // 清掉冷却，让用户能立刻看到评估结果
        const c = this.app.storage.getStorageConfig() || {};
        delete c.lastAutoCompactAt;
        this.app.storage.updateStorageConfig?.(c);
        setTimeout(() => this.app.maybeAutoCompact?.('手动触发'), 300);
    }

    // ==================== 导航分组折叠 ====================

    /** 侧边栏分组折叠。状态存 localStorage，刷新后保持。 */
    toggleNavGroup(name) {
        const key = 'gd_navgroup_' + name;
        const header = document.querySelector(`.nav-group-header[data-group="${name}"]`);
        const body = document.querySelector(`.nav-group-body[data-group-body="${name}"]`);
        if (!header || !body) return;
        const open = !body.classList.contains('open');
        body.classList.toggle('open', open);
        header.classList.toggle('open', open);
        try { localStorage.setItem(key, open ? '1' : '0'); } catch (e) {}
    }

    /** 恢复折叠状态（默认展开） */
    restoreNavGroups() {
        document.querySelectorAll('.nav-group-header[data-group]').forEach(header => {
            const name = header.getAttribute('data-group');
            const body = document.querySelector(`.nav-group-body[data-group-body="${name}"]`);
            if (!body) return;
            let open = true;
            try { const v = localStorage.getItem('gd_navgroup_' + name); if (v !== null) open = v === '1'; } catch (e) {}
            body.classList.toggle('open', open);
            header.classList.toggle('open', open);
        });
    }

    // ==================== 后台进程 ====================

    /**
     * 后台进程面板：所有耗时任务的统一入口。
     *
     * ★ 为什么要在侧边栏单独加一个入口：
     *   小窗是"贴边显示"的，超过 3 个就合并成一张卡，
     *   合并之后点开是列表、再点才是详情 —— 想看全局很费劲。
     *   这里直接一次列全，进度、子项、失败原因都在。
     *
     * ★ 打开时小窗会"飞"进来（TaskDock.flyToList），
     *   给用户一个"它们都跑这儿来了"的视觉交代，而不是凭空列出一堆行。
     */
    /**
     * 后台进程：显示在主窗口（不是弹窗）。
     *
     * ★ 为什么改：
     *   原来用 showModal 弹窗。弹窗是叠在文件列表上的浮层 ——
     *   看任务的时候没法同时翻文件，而"传完了没、要不要接着传"
     *   恰恰需要边看进度边决定。而且弹窗一关进度就断了。
     *   现在走 switchView('tasks')，像"最近/收藏"一样占主窗口。
     */
    showTaskManager() {
        // 侧边栏高亮同步（走 nav 的话 switchView 已经切过了，这里兜底）
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === 'tasks');
        });
        this.switchView('tasks');
    }

    /** 主窗口渲染后台进程 */
    /**
     * 顶栏常驻后，按视图同步按钮可用态。
     * 直接隐藏会造成"点了没反应"，所以改成置灰 + 提示。
     * 用户自己在右键菜单里勾掉的项（hidden）不受影响。
     */
    _syncToolbarForView(view) {
        const isFiles = (view === 'all-files');
        // 只依赖当前文件列表上下文的按钮
        const FILE_ONLY = ['#adv-search-btn', '#folder-tree-btn', '#view-toggle-btn'];
        FILE_ONLY.forEach(sel => {
            const el = document.querySelector('.toolbar ' + sel)
                    || document.querySelector(sel);
            if (!el) return;
            el.disabled = !isFiles;
            el.classList.toggle('gd-bar-off', !isFiles);
            el.title = isFiles ? '' : '切换到「全部文件」后可用';
        });
    }

    _renderTasksView() {
        const fileList = document.getElementById('file-list');
        if (!fileList) return;
        // ★ 显示前必须清掉内联 display:none ——
        //   switchView 对非文件视图写过 style.display='none'，
        //   内联样式优先级高于 CSS 类，只改 className 不管用
        //   （之前"我的分享"列表空白就是这个原因）。
        fileList.style.display = '';
        // ★ 不能只给 'file-list'：它是 display:grid（文件格子布局），
        //   .tasks-view 会变成一个 grid item 被压进第一列（约 180px），
        //   于是整个后台进程视图挤在左上角，margin:0 auto 也不生效。
        //   加 gd-tasks-host 把它改回块级，居中才真的居中。
        fileList.className = 'file-list gd-tasks-host';
        // ★ 插件预览区和任务列表分开：
        //   任务列表每 700ms 刷新一次，预览区不能跟着重建，
        //   否则预览卡会被销毁再生成，插件窗口每 0.7 秒闪一下。
        fileList.innerHTML = '<div class="tasks-view" id="task-mgr-body">'
            + '<div id="tm-stages"></div><div id="tm-list"></div></div>';
        this._renderPluginStages();
        this._renderTaskList();
    }

    /** 插件预览区：内容没变就不重绘（只在插件增减时重建） */
    _renderPluginStages() {
        const box = document.getElementById('tm-stages');
        if (!box) return;
        if (typeof TaskDock === 'undefined' || !TaskDock.pluginStagesHTML) return;
        const html = TaskDock.pluginStagesHTML();
        if (box.getAttribute('data-sig') !== html) {
            box.innerHTML = html;
            box.setAttribute('data-sig', html);
        }
        try { TaskDock.bindPluginStages(box); } catch (e) { console.warn(e); }
    }

    _renderTaskList() {
        const box = document.getElementById('tm-list');
        if (!box) return;
        box.innerHTML = this._taskManagerHTML();
        this._bindTaskManager(box);
    }

    /** 后台进程视图的实时刷新（跑着的任务要能看到进度在动） */
    _startTasksRefresh() {
        const refresh = () => {
            // 已经不在后台进程视图了就停
            if (this.app?._currentView !== 'tasks') { this._stopTasksRefresh(); return; }
            this._renderTaskList();
            this._renderPluginStages();
        };
        this._stopTasksRefresh();
        this._taskMgrTimer = setInterval(refresh, 700);
    }

    _stopTasksRefresh() {
        clearInterval(this._taskMgrTimer);
        this._taskMgrTimer = null;
        // 离开视图 → 还在跑的任务回到边缘小窗
        try { TaskDock.resumeMini && TaskDock.resumeMini(); } catch (e) {}
        // 预览区销毁 → 收起的插件窗口先藏起来，等下次进来再贴上去
        try { TaskDock.stopPluginStages && TaskDock.stopPluginStages(); } catch (e) {}
    }

    _taskManagerHTML() {
        if (typeof TaskDock === 'undefined' || !TaskDock.all) {
            return '<div style="font-size:13px;color:#6b7280;">任务模块未加载</div>';
        }
        const all = TaskDock.all();
        if (!all.length) {
            return `<div class="gd-tasks-empty">
                      <div class="tv-ico">✅</div>
                      <div class="tv-t">没有正在进行的任务</div>
                      <div class="tv-s">
                        上传、下载、分享、整理仓库都会出现在这里
                      </div></div>`;
        }
        const ico = { upload: '📤', download: '⬇️', share: '🔗', compact: '🧹' };
        const esc = v => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const ago = ts => {
            if (!ts) return '';
            const s = Math.floor((Date.now() - ts) / 1000);
            if (s < 60) return s + ' 秒前';
            if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
            return Math.floor(s / 3600) + ' 小时前';
        };

        // 跑着的排前面，其次失败，最后已完成
        const rank = { running: 0, error: 1, done: 2 };
        all.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.startedAt - a.startedAt);

        let h = '';
        const running = all.filter(t => t.status === 'running').length;
        const errored = all.filter(t => t.status === 'error').length;
        if (running || errored) {
            h += `<div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
                    ${running ? `进行中 ${running}` : ''}${running && errored ? ' · ' : ''}${errored ? `<span style="color:#dc2626;">失败 ${errored}</span>` : ''}
                  </div>`;
        }

        for (const t of all) {
            const cls = t.status === 'error' ? ' is-error' : (t.status === 'done' ? ' is-done' : '');
            const sub = t.status === 'error'
                ? `<span style="color:#dc2626;">${esc(t.error || '失败')}</span>`
                : t.status === 'done'
                    ? (t.note || '已完成')
                    : (t.single ? (t.note || '处理中')
                        : `${t.items.filter(i => i.status === 'done').length}/${t.items.length} 个文件`);
            let detail = '';
            if (!t.single && t.items.length) {
                // 子项只显示有状态的：已完成/失败/正在跑
                const rows = t.items.filter(i => i.status !== 'pending').slice(-40);
                if (rows.length) {
                    detail = '<div class="task-mgr-items">' + rows.map(i =>
                        `<div><span class="${i.status === 'done' ? 'ok' : (i.status === 'error' ? 'bad' : '')}">${
                            i.status === 'done' ? '✓' : (i.status === 'error' ? '✗' : '·')}</span> ${esc(i.name)}</div>`
                    ).join('') + '</div>';
                }
            }
            h += `<div class="task-mgr-row${cls}" data-id="${t.id}">
                    <div class="task-mgr-ico">${ico[t.type] || '📋'}</div>
                    <div class="task-mgr-main">
                        <div class="task-mgr-title">${esc(t.title)}</div>
                        <div class="task-mgr-sub">${sub}</div>
                        <div class="task-mgr-bar"><div class="task-mgr-fill" style="width:${t.percent}%"></div></div>
                        ${detail}
                    </div>
                    <div class="task-mgr-right">
                        <div>${t.percent}%</div>
                        <div style="font-size:11px;color:#9ca3af;margin-top:3px;">${ago(t.startedAt)}</div>
                    </div>
                  </div>`;
        }

        const finished = all.filter(t => t.status !== 'running').length;
        h += `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
                ${finished ? '<button class="btn-secondary btn-sm" onclick="ui.clearFinishedTasks()">清除已结束的（${finished}）</button>' : ''}
                <button class="btn-secondary btn-sm" onclick="typeof TaskDock!=='undefined'&&TaskDock.resumeMini&&TaskDock.resumeMini();ui.closeModal();">关闭</button>
              </div>`.replace('${finished}', finished);
        return h;
    }

    _bindTaskManager(box) {
        if (!box) return;
        box.querySelectorAll('.task-mgr-row').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.getAttribute('data-id');
                if (id && typeof TaskDock !== 'undefined' && TaskDock.open) TaskDock.open(id);
            });
        });
    }

    /** 清除已结束（完成/失败）的任务 */
    clearFinishedTasks() {
        if (typeof TaskDock === 'undefined' || !TaskDock.all) return;
        for (const t of TaskDock.all()) {
            if (t.status !== 'running' && TaskDock.remove) TaskDock.remove(t.id);
        }
        this.showTaskManager();
    }

    /** 更新"后台进程"入口的角标 */
    updateTaskBadge() {
        let running = 0;
        try {
            if (typeof TaskDock !== 'undefined' && TaskDock.all) {
                running = TaskDock.all().filter(t => t.status === 'running').length;
            }
        } catch (e) { return; }
        const show = running > 0;
        [[ 'nav-badge-tasks', 'mobile-badge-tasks' ]].flat().forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.display = show ? '' : 'none';
            el.textContent = running > 99 ? '99+' : String(running);
        });
    }

    // ==================== 移动端「更多」面板 ====================

    /**
     * 移动端唯一导航：左侧抽屉。
     *
     * ★ 演变：原来移动端左侧是抽屉、底部又是 tab，两套入口干同一件事 ——
     *   用户直接问"为什么左边有侧边栏，下面也有侧边栏"。
     *   中间一度改成"底部 tab + 更多面板"，用户选了反过来：
     *   留抽屉、去掉底部。理由是抽屉装得下更多条目，
     *   而底部只能塞 5 个图标，后台进程之类的功能挤不进去。
     */
    toggleMobileMenu(force) {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        // 电脑端侧边栏本来就常驻，不需要抽屉
        try {
            if (!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches)) return;
        } catch (e) { return; }

        // ★ 关键：清掉 as-sheet。侧边栏节点是复用的，
        //   旧版把它变成过"从底部滑出"的面板，残留这个 class 会让抽屉从底部冒出来。
        sidebar.classList.remove('as-sheet');

        // 用侧边栏自己的遮罩（#sidebar-overlay），不再另建 sheet-overlay
        let overlay = document.getElementById('sidebar-overlay');
        if (overlay && !overlay._gdBound) {
            overlay.addEventListener('click', () => this.toggleMobileMenu(false));
            overlay._gdBound = true;
        }

        const open = force !== undefined ? force : !sidebar.classList.contains('open');
        sidebar.classList.toggle('open', open);
        if (overlay) overlay.classList.toggle('active', open);
    }

    // ==================== 工具栏：文件夹导航 / 高级筛选 ====================

    /** HTML 转义（渲染文件名、路径等不可信内容时必须用） */
    _escHtml(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** 属性转义：比 _escHtml 多转义反引号和等号，防止拼进 data-* 后截断属性 */
    _escAttr(v) {
        return this._escHtml(v).replace(/`/g, '&#96;').replace(/=/g, '&#61;');
    }

    /**
     * 🗂️ 文件夹导航
     *
     * ★ 为什么之前"按了没反应"：
     *   index.html 里绑了 click → this.showFolderTree()，
     *   但这个方法从来没被实现过 —— 点了直接抛
     *   "this.showFolderTree is not a function"，界面上没有任何反应。
     *   这是最容易漏的一类 bug：绑定写了、实现没写，静态看不出来。
     */
    showFolderTree() {
        const vfs = this.app?.storage?.getVFS?.();
        if (!vfs) { this.showToast?.('数据还没加载完', 'info'); return; }

        // 从 vfs.folders 还原整棵树（它是 path -> info 的扁平 map）
        const paths = Object.keys(vfs.folders || {}).filter(p => p && p !== '/drive_home');
        if (!paths.length) {
            this.showModal('🗂️ 文件夹导航',
                '<div style="font-size:13px;color:#6b7280;padding:8px 0;">还没有任何文件夹</div>', '', true);
            return;
        }
        paths.sort();

        // 每个文件夹下挂多少文件（只数直接子文件，够用且不卡）
        const countIn = (dir) => {
            const prefix = dir + '/';
            return Object.keys(vfs.files || {}).filter(f =>
                f.startsWith(prefix) && !f.substring(prefix.length).includes('/')).length;
        };

        const cur = this.app.fileManager?.getCurrentPath?.() || '/drive_home';
        const rows = paths.map(p => {
            const name = p.split('/').pop() || p;
            const depth = p.split('/').length - 2;          // /drive_home/x 的 depth = 0
            const n = countIn(p);
            const isCur = p === cur;
            return `<div class="ft-row${isCur ? ' is-cur' : ''}" data-path="${this._escAttr(p)}"
                        style="padding-left:${8 + Math.max(0, depth) * 16}px">
                        <span class="ft-ico">📁</span>
                        <span class="ft-name">${this._escHtml(name)}</span>
                        <span class="ft-count">${n ? n + ' 个文件' : '空'}</span>
                    </div>`;
        }).join('');

        const body = `<div class="folder-tree" id="folder-tree-box">${rows}</div>`;
        this.showModal('🗂️ 文件夹导航', body, '', true);

        document.getElementById('folder-tree-box')?.querySelectorAll('.ft-row').forEach(row => {
            row.addEventListener('click', () => {
                const path = row.getAttribute('data-path');
                this.closeModal?.();
                this.app.fileManager?.setCurrentPath?.(path);
                this.app.fileManager?.setCurrentRepo?.(null);
                this.switchView('all-files');
                // switchView('all-files') 会把路径重置成 last_state，这里再改回去
                setTimeout(() => {
                    this.app.fileManager?.setCurrentPath?.(path);
                    this.app.loadFiles?.();
                }, 0);
            });
        });
    }

    /**
     * ⚙️ 高级筛选
     *
     * ★ 同样是"绑了 click 但方法没实现"，点了完全没反应。
     */
    showAdvancedSearch() {
        const vfs = this.app?.storage?.getVFS?.();
        if (!vfs) { this.showToast?.('数据还没加载完', 'info'); return; }

        // 统计现有扩展名，避免给用户一个空的分类列表
        const exts = new Set();
        Object.keys(vfs.files || {}).forEach(f => {
            const m = f.match(/\.([^./]+)$/);
            if (m) exts.add(m[1].toLowerCase());
        });
        const extList = [...exts].sort();

        const body = `
            <div class="adv-search" id="adv-search-box">
                <div class="adv-field">
                    <label>文件类型</label>
                    <div class="adv-chips" id="adv-exts">
                        <span class="adv-chip is-on" data-ext="">全部</span>
                        ${extList.map(e => `<span class="adv-chip" data-ext="${this._escAttr(e)}">.${this._escHtml(e)}</span>`).join('')}
                    </div>
                </div>
                <div class="adv-field">
                    <label>大小</label>
                    <select id="adv-size">
                        <option value="">不限</option>
                        <option value="s">&lt; 1 MB</option>
                        <option value="m">1 MB ~ 10 MB</option>
                        <option value="l">&gt; 10 MB</option>
                    </select>
                </div>
                <div class="adv-field">
                    <label>名称包含</label>
                    <input type="text" id="adv-name" placeholder="留空则不过滤">
                </div>
                <div id="adv-count" class="adv-count"></div>
                <div class="adv-actions">
                    <button class="btn-secondary" id="adv-cancel">取消</button>
                    <button class="btn-primary" id="adv-apply">🔍 应用筛选</button>
                </div>
            </div>`;

        // ★ 注意：showModal 只收 4 个参数，第 5 个按钮数组会被静默忽略 ——
        //   按钮根本渲染不出来。所以按钮直接放进 body，
        //   不去改 showModal 签名（它还有 30+ 处调用）。
        this.showModal('⚙️ 高级筛选', body, '', true);
        document.getElementById('adv-cancel')?.addEventListener('click', () => this.closeModal?.());
        document.getElementById('adv-apply')?.addEventListener('click', () => this._applyAdvancedSearch());

        const box = document.getElementById('adv-search-box');
        box?.querySelectorAll('.adv-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                box.querySelectorAll('.adv-chip').forEach(c => c.classList.remove('is-on'));
                chip.classList.add('is-on');
                if (chip.getAttribute('data-ext') !== '') {
                    box.querySelectorAll('.adv-chip').forEach(c => {
                        if (c.getAttribute('data-ext') === '') c.classList.remove('is-on');
                    });
                }
            });
        });
        box?.querySelectorAll('#adv-size,#adv-name').forEach(el =>
            el.addEventListener('input', () => this._previewAdvancedSearch()));
        box?.querySelectorAll('.adv-chip').forEach(c =>
            c.addEventListener('click', () => this._previewAdvancedSearch()));
        this._previewAdvancedSearch();
    }

    _advFilter() {
        const box = document.getElementById('adv-search-box');
        const ext = box?.querySelector('.adv-chip.is-on')?.getAttribute('data-ext') || '';
        const size = box?.querySelector('#adv-size')?.value || '';
        const name = (box?.querySelector('#adv-name')?.value || '').trim().toLowerCase();
        const vfs = this.app.storage.getVFS();

        return Object.entries(vfs.files || {}).filter(([path, info]) => {
            if (ext && !path.toLowerCase().endsWith('.' + ext)) return false;
            if (name && !path.toLowerCase().includes(name)) return false;
            const sz = info.size || 0;
            if (size === 's' && sz >= 1024 * 1024) return false;
            if (size === 'm' && (sz < 1024 * 1024 || sz >= 10 * 1024 * 1024)) return false;
            if (size === 'l' && sz < 10 * 1024 * 1024) return false;
            return true;
        }).map(([path, info]) => ({ ...info, path, isFile: true }));
    }

    _previewAdvancedSearch() {
        const el = document.getElementById('adv-count');
        if (!el) return;
        try {
            const n = this._advFilter().length;
            el.textContent = n ? `匹配 ${n} 个文件` : '没有匹配的文件';
        } catch (e) { /* 预览失败不影响应用 */ }
    }

    _applyAdvancedSearch() {
        let items = [];
        try { items = this._advFilter(); } catch (e) { items = []; }
        this.closeModal?.();
        this.app.currentFiles = items;
        this.app._isFilterResult = true;
        this.ui?.renderFileList?.(items);
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        this.showToast?.(`筛选出 ${items.length} 个文件`, 'info');
    }

    /**
     * 移动端是否禁用插件。
     *
     * ★ 改过一次：原来返回 true（移动端一律拦截），理由是"下载不了插件后端"。
     *   但实际上插件有两种来源：仓库里的 html（blob 直接跑）和外部 URL，
     *   都不依赖本地后端，移动端能跑。
     *   现在返回 false —— 移动端照样用插件，只是交互换成手机习惯的那套
     *   （见 _mountMobilePlugin：不飘小窗，去「后台进程」里看实时预览）。
     */
    isPluginsBlocked() {
        return false;
    }

    /** 窄屏判定（<=768px）：插件走移动端交互，任务坞小窗也据此隐藏 */
    isMobileViewport() {
        try {
            return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
        } catch (e) { return false; }
    }

    /** 存储仓库管理（内容由 app.showStorageManager 填充） */
    showStorageManager() {
        const body = '<div id="storage-mgr-body" style="padding:8px 0;">'
                   + '<div style="font-size:13px;color:#6b7280;">正在读取仓库体积…</div></div>';
        this.showModal('🗂️ 存储仓库管理', body, '', true);
        // 弹窗已插入 DOM 后再异步填充
        setTimeout(() => this.app?.showStorageManager?.(), 50);
    }

    /**
     * 一键优化仓库存储
     *
     * ★ 与"仓库维护"的区别：
     *   维护 = 把孤儿恢复成可见文件（只增不删）
     *   优化 = 把孤儿彻底删掉（释放容量）
     *
     *   用户遇到的是"仓库满了传不进去"，要的是后者。
     */
    showStorageOptimizer() {
        const body = `
            <div style="padding:8px 0;">
                <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:14px;">
                    扫描仓库，找出三类问题：<br>
                    · <b>用量登记虚高</b>——"存储满了"最常见的真因，校准即可找回<br>
                    · <b>孤儿分片</b>——覆盖上传留下的旧数据，可删除释放<br>
                    · <b>幽灵记录</b>——文件已丢失但记录还在，点了就报错
                </div>
                <div id="opt-result" style="display:none;margin-bottom:14px;"></div>
                <button id="opt-scan-btn" class="btn-primary btn-sm"
                    onclick="ui.runStorageOptimize('scan')">
                    🔍 先看看能释放多少
                </button>
            </div>
        `;
        this.showModal('⚡ 一键优化仓库存储', body, '', true);
    }

    _optFmt(n) {
        const u = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0; n = parseFloat(n || 0);
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
    }

    async runStorageOptimize(stage) {
        const box = document.getElementById('opt-result');
        const btn = document.getElementById('opt-scan-btn');
        if (!box) return;
        box.style.display = 'block';

        const app = this.app;
        if (!app.maintain) app.maintain = new Maintain(app.api, app.storage);

        if (stage === 'scan') {
            btn.disabled = true;
            btn.textContent = '扫描中…';
            box.innerHTML = '<div style="font-size:13px;color:#6b7280;">正在读取仓库文件树…</div>';
            try {
                const rep = await app.maintain.scan((d, t, l) => {
                    box.innerHTML = '<div style="font-size:13px;color:#6b7280;">扫描中 ' + d + '/' + t + '：' + l + '</div>';
                });
                this._optReport = rep;
                box.innerHTML = this._renderOptimizeReport(rep);
                btn.textContent = '重新扫描';
                btn.disabled = false;
            } catch (e) {
                box.innerHTML = '<div style="color:#dc2626;font-size:13px;">扫描失败：' + (e && e.message || e) + '</div>';
                btn.textContent = '重试';
                btn.disabled = false;
            }
            return;
        }

        if (stage === 'recalibrate') { await this.runRecalibrate(); return; }
        if (stage === 'dropGhosts') { await this.runDropGhosts(); return; }

        if (stage === 'purge') {
            const rep = this._optReport;
            if (!rep || !rep.orphans || !rep.orphans.length) return;
            const dry = await app.maintain.purge(rep.orphans, { dryRun: true });
            if (!dry.would_delete) {
                box.innerHTML = '<div style="color:#059669;font-size:13px;">✓ 没有需要清理的内容</div>';
                return;
            }
            // ★ 删除不可逆，必须让用户明确输入数量确认，不能只有一个 confirm
            const answer = prompt(
                '将永久删除 ' + dry.would_delete + ' 个孤儿分片，释放 ' + this._optFmt(dry.freed_bytes) + '。\n\n' +
                '此操作不可撤销（GitHub 仓库历史里仍可找回，但 Drive 里看不到了）。\n' +
                '确认请输入数字 ' + dry.would_delete + ' ：');
            if (answer === null) { box.innerHTML = '<div style="font-size:13px;color:#6b7280;">已取消</div>'; return; }
            if (String(answer).trim() !== String(dry.would_delete)) {
                box.innerHTML = '<div style="color:#dc2626;font-size:13px;">数字不一致，已取消</div>';
                return;
            }

            box.innerHTML = '<div style="font-size:13px;color:#6b7280;">正在删除…</div>';
            try {
                const res = await app.maintain.purge(rep.orphans, {
                    onProgress: (d, t, l) => {
                        box.innerHTML = '<div style="font-size:13px;color:#6b7280;">删除中 ' + d + '/' + t + '：' + l + '</div>';
                    }
                });
                let h = '<div style="font-size:13px;line-height:1.7;">';
                h += '<div style="color:#059669;">✓ 已释放 <b>' + this._optFmt(res.freed_bytes) + '</b></div>';
                h += '删除 <b>' + res.deleted.length + '</b> 个分片<br>';
                if (res.skipped_system) h += '<span style="color:#6b7280;">跳过系统文件 ' + res.skipped_system + ' 个（README 等）</span><br>';
                if (res.skipped_stale) h += '<span style="color:#6b7280;">跳过 ' + res.skipped_stale + ' 个（扫描后又变成在用状态）</span><br>';
                if (res.failed.length) h += '<span style="color:#dc2626;">失败 ' + res.failed.length + ' 个</span>';
                h += '</div>';
                box.innerHTML = h;
                this._optReport = null;
                if (app.loadFiles) app.loadFiles();
            } catch (e) {
                box.innerHTML = '<div style="color:#dc2626;font-size:13px;">清理失败：' + (e && e.message || e) + '</div>';
            }
        }
    }

    /**
     * 渲染优化报告。
     *
     * ★ 关键改动：以前只看孤儿，没有孤儿就报"无需清理" ——
     *   但用户遇到的"存储满了"往往根本不是孤儿造成的，
     *   而是**用量登记值虚高**（recalibrate 能解决）。
     *   所以这里必须同时给出登记值 vs 实际值的偏差，并提供校准入口。
     */
    _renderOptimizeReport(rep) {
        const fmt = this._optFmt;
        let h = '<div style="font-size:13px;line-height:1.7;">';
        h += '记录占用 <b>' + fmt(rep.recorded_bytes) + '</b>　' +
             '仓库实际 <b>' + fmt(rep.actual_bytes) + '</b><br>';

        // ── ① 用量登记偏差（最常见的"满了"真因）──
        const usage = rep.usage_actual || {};
        const reg = (this.app && this.app.storage) ? this.app.storage.getRepoUsage() : {};
        let regTotal = 0, actTotal = 0;
        const drift = [];
        for (const key of Object.keys(usage)) {
            const a = parseInt(usage[key], 10) || 0;
            const r = (reg[key] && reg[key].size) || 0;
            regTotal += r; actTotal += a;
            if (r - a > 1048576) drift.push({ key: key, before: r, after: a });
        }
        const driftBytes = Math.max(0, regTotal - actTotal);
        if (drift.length) {
            const pct = regTotal ? (driftBytes / regTotal * 100).toFixed(0) : 0;
            h += '<div style="color:#dc2626;margin-top:10px;">' +
                 '★ 用量登记虚高 <b>' + fmt(driftBytes) + '</b>（' + pct + '%）' +
                 '<div style="font-size:12px;color:#6b7280;margin-top:4px;line-height:1.5;">' +
                 '登记 ' + fmt(regTotal) + '，仓库实际只有 ' + fmt(actTotal) + '。<br>' +
                 '选仓库和"是否已满"看的是登记值 —— 这就是为什么明明有空间却传不进去。</div></div>';
            h += '<button class="btn-primary btn-sm" style="margin-top:10px;" ' +
                 'onclick="ui.runStorageOptimize(\'recalibrate\')">🔧 校准用量（不删任何文件）</button>';
        }

        // ── ② 孤儿 ──
        if (rep.orphans.length) {
            const pct = rep.actual_bytes
                ? (rep.orphan_bytes / rep.actual_bytes * 100).toFixed(0) : 0;
            h += '<div style="color:#d97706;margin-top:10px;">' +
                 '孤儿 <b>' + rep.orphans.length + '</b> 个 · 可释放 <b>' + fmt(rep.orphan_bytes) + '</b>' +
                 '（占仓库 ' + pct + '%）</div>';
            h += '<button class="btn-primary btn-sm" style="margin-top:10px;" ' +
                 'onclick="ui.runStorageOptimize(\'purge\')">⚡ 立即清理</button>';
        }

        // ── ③ 幽灵 ──
        if (rep.ghosts.length) {
            h += '<div style="color:#dc2626;margin-top:10px;">' +
                 '⚠ 幽灵 <b>' + rep.ghosts.length + '</b> 个：文件已不在仓库，下载必失败' +
                 '<div style="font-size:12px;color:#6b7280;margin-top:4px;">' +
                 '数据已经丢了，但记录还占着容量、点了就报错。</div></div>';
            h += '<button class="btn-danger btn-sm" style="margin-top:10px;" ' +
                 'onclick="ui.runStorageOptimize(\'dropGhosts\')">🗑 移除这些失效记录</button>';
        }

        if (!drift.length && !rep.orphans.length && !rep.ghosts.length) {
            h += '<div style="color:#059669;margin-top:10px;">✓ 仓库是干净的，没有孤儿也没有虚高</div>';
        }
        return h + '</div>';
    }

    async runRecalibrate() {
        const box = document.getElementById('opt-result');
        if (!box) return;
        const rep = this._optReport;
        if (!rep) return;
        const app = this.app;
        box.innerHTML = '<div style="font-size:13px;color:#6b7280;">正在校准…</div>';
        try {
            const r = await app.maintain.recalibrateUsage(rep);
            let h = '<div style="font-size:13px;line-height:1.7;">';
            h += '<div style="color:#059669;">✓ 已校准，找回 <b>' + this._optFmt(r.freedBytes) + '</b> 虚假占用</div>';
            h += '<div style="font-size:12px;color:#6b7280;">' +
                 '登记 ' + this._optFmt(r.beforeBytes) + ' → ' + this._optFmt(r.afterBytes) +
                 '（修正 ' + r.fixed.length + ' 个仓库，未删除任何文件）</div>';
            for (const f of r.fixed.slice(0, 5)) {
                h += '<div style="font-size:12px;color:#6b7280;">· ' + f.key.split('/')[1] +
                     '：' + this._optFmt(f.before) + ' → ' + this._optFmt(f.after) + '</div>';
            }
            h += '</div>';
            box.innerHTML = h;
            if (app.loadFiles) app.loadFiles();
        } catch (e) {
            box.innerHTML = '<div style="color:#dc2626;font-size:13px;">校准失败：' + (e && e.message || e) + '</div>';
        }
    }

    async runDropGhosts() {
        const box = document.getElementById('opt-result');
        if (!box) return;
        const rep = this._optReport;
        if (!rep || !rep.ghosts || !rep.ghosts.length) return;
        const app = this.app;
        const dry = await app.maintain.dropGhosts(rep.ghosts, { dryRun: true });
        const paths = Array.from(new Set(rep.ghosts.map(g => g.vpath)));
        const answer = prompt(
            '将移除 ' + dry.would_remove + ' 条失效的文件记录：\n\n' +
            paths.slice(0, 5).join('\n') + (paths.length > 5 ? '\n…' : '') + '\n\n' +
            '这些文件的分片在仓库里已经不存在，本来也下不下来。\n' +
            '此操作只删 Drive 里的记录，不会删除仓库中任何文件。\n\n' +
            '确认请输入数字 ' + dry.would_remove + ' ：');
        if (answer === null) { box.innerHTML = '<div style="font-size:13px;color:#6b7280;">已取消</div>'; return; }
        if (String(answer).trim() !== String(dry.would_remove)) {
            box.innerHTML = '<div style="color:#dc2626;font-size:13px;">数字不一致，已取消</div>';
            return;
        }
        try {
            const res = await app.maintain.dropGhosts(rep.ghosts, {});
            box.innerHTML = '<div style="color:#059669;font-size:13px;">✓ 已移除 ' +
                res.removed.length + ' 条失效记录</div>';
            this._optReport = null;
            if (app.loadFiles) app.loadFiles();
        } catch (e) {
            box.innerHTML = '<div style="color:#dc2626;font-size:13px;">移除失败：' + (e && e.message || e) + '</div>';
        }
    }

    /**
     * 仓库维护：孤儿/幽灵检测与恢复
     *
     * ★ 为什么入口在设置里而不是工具栏：
     *   这是维护动作，不是日常操作，不该占主界面。
     */
    showMaintain() {
        const body = `
            <div style="padding:8px 0;">
                <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:14px;">
                    扫描所有存储仓库，找出两类问题：<br>
                    · <b>孤儿</b>：仓库里有数据，但界面看不见（覆盖上传留下的旧分片）<br>
                    · <b>幽灵</b>：界面看得见，但数据已丢失（下载必失败）
                </div>
                <div id="maintain-result" style="display:none;margin-bottom:14px;"></div>
                <button id="maintain-scan-btn" class="btn-primary btn-sm"
                    onclick="ui.runMaintainScan()">
                    🔍 开始扫描
                </button>
            </div>
        `;
        this.showModal('🧹 仓库维护', body, '', true);
    }

    async runMaintainScan() {
        const btn = document.getElementById('maintain-scan-btn');
        const box = document.getElementById('maintain-result');
        if (!btn || !box) return;

        btn.disabled = true;
        btn.textContent = '扫描中…';
        box.style.display = 'block';
        box.innerHTML = '<div style="font-size:13px;color:#6b7280;">正在读取仓库文件树，仓库多时可能较慢…</div>';

        try {
            const app = this.app;
            if (!app.maintain) app.maintain = new Maintain(app.api, app.storage);
            const rep = await app.maintain.scan(function (done, total, label) {
                box.innerHTML = '<div style="font-size:13px;color:#6b7280;">' +
                    '扫描中 ' + done + '/' + total + '：' + label + '</div>';
            });
            this._maintainReport = rep;
            box.innerHTML = this.renderMaintainReport(rep);
            btn.textContent = '重新扫描';
            btn.disabled = false;
        } catch (e) {
            box.innerHTML = '<div style="color:#dc2626;font-size:13px;">扫描失败：' +
                (e && e.message || e) + '</div>';
            btn.textContent = '重试';
            btn.disabled = false;
        }
    }

    renderMaintainReport(rep) {
        const fmt = function (n) {
            const u = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0; n = parseFloat(n || 0);
            while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
            return (i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
        };
        let h = '<div style="font-size:13px;line-height:1.7;">';
        h += '记录文件 <b>' + (rep.file_count || 0) + '</b> 个，' +
             '占用 <b>' + fmt(rep.recorded_bytes) + '</b><br>';
        h += '仓库实际 <b>' + fmt(rep.actual_bytes) + '</b><br>';

        const oc = rep.orphans.length;
        const gc = rep.ghosts.length;
        if (oc === 0 && gc === 0) {
            h += '<div style="color:#059669;margin-top:8px;">✓ 没有发现问题</div>';
        } else {
            if (oc) {
                h += '<div style="color:#d97706;margin-top:8px;">' +
                     '★ 孤儿 <b>' + oc + '</b> 个 · ' + fmt(rep.orphan_bytes) +
                     '<br><span style="font-size:12px;color:#6b7280;">' +
                     '界面看不见但占着容量，可恢复到 _recovered 目录</span></div>';
            }
            if (gc) {
                h += '<div style="color:#dc2626;margin-top:8px;">' +
                     '★ 幽灵 <b>' + gc + '</b> 个' +
                     '<br><span style="font-size:12px;color:#6b7280;">' +
                     '这些文件下载必失败</span></div>';
            }
        }
        if (rep.errors && rep.errors.length) {
            h += '<div style="color:#dc2626;margin-top:8px;">' +
                 '扫描出错 ' + rep.errors.length + ' 个仓库</div>';
        }
        h += '</div>';

        if (oc) {
            h += '<button class="btn-primary btn-sm" style="margin-top:12px;" ' +
                 'onclick="ui.runMaintainRecover()">' +
                 '♻️ 恢复到 _recovered（' + oc + ' 个）</button>';
            h += '<div style="font-size:12px;color:#6b7280;margin-top:6px;">' +
                 '只增不删：重名自动加序号，不会覆盖现有文件</div>';
        }
        return h;
    }

    async runMaintainRecover() {
        const rep = this._maintainReport;
        const box = document.getElementById('maintain-result');
        if (!rep || !box) return;
        if (!confirm('将 ' + rep.orphans.length + ' 个孤儿恢复到 /drive_home/_recovered。\n\n' +
                     '只增不删，不会覆盖现有文件。继续？')) return;

        try {
            const app = this.app;
            const res = app.maintain.recover(rep.orphans);
            app.storage.setVFS(res.vfs);
            // ★ 必须推到远端，否则只在本地生效
            if (app.configSync && app.configSync.pushConfig) {
                await app.configSync.pushConfig();
            }
            box.innerHTML = '<div style="font-size:13px;line-height:1.7;">' +
                '<div style="color:#059669;">✓ 恢复完成</div>' +
                '新增 <b>' + res.added.length + '</b> 个文件<br>' +
                (res.conflicts.length ? '跳过（已存在）' + res.conflicts.length + ' 个<br>' : '') +
                (res.skipped.length ? '忽略（隐藏文件/空名）' + res.skipped.length + ' 个<br>' : '') +
                '<div style="margin-top:8px;color:#6b7280;">' +
                '请到 /drive_home/_recovered 查看</div></div>';
            this._maintainReport = null;
            if (app.loadFiles) app.loadFiles();
        } catch (e) {
            box.innerHTML = '<div style="color:#dc2626;font-size:13px;">恢复失败：' +
                (e && e.message || e) + '</div>';
        }
    }

    /** 分支名白名单校验。清单/URL/手输三处共用，不能各写各的。 */
    _safeBranch(b) {
        if (typeof b !== 'string') return null;
        const t = b.trim();
        if (!t || t.length > 200) return null;
        if (!/^[A-Za-z0-9._\/-]+$/.test(t)) return null;
        if (t.indexOf('..') !== -1) return null;
        return t;
    }

    /**
     * 版本广场
     *
     * ★ 与旧版的三处关键差别：
     *   1. 切换前先探活。实测 preview/AI-Agent/dark-mode 在 jsdelivr 上是
     *      404 —— 点下去就是白屏，而白屏里设置页打不开，切不回来（死锁）。
     *      现在不可用的分支直接标灰、点了也不加载。
     *   2. 分支清单不只看 preview-branches.json（它漏了 10 个分支，
     *      实际有 22 个），改为登录后用 API 列出全部 preview/* 再合并元数据。
     *   3. 手动输入分支名之前没有校验（loadVersion 有、switchBranch 没有），
     *      现在统一走 _safeBranch。
     */
    showVersionSwitcher() {
        this._vsFilter = '';
        this._vsSort = 'time';
        const cur = localStorage.getItem('gd_custom_branch') || 'main';
        const body = `
            <div style="padding:8px 0;">
                <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;margin-bottom:14px;">
                    <div style="font-size:13px;color:#1e40af;font-weight:600;margin-bottom:4px;">💡 版本广场</div>
                    <div style="font-size:12px;color:#1e40af;line-height:1.5;">
                        开发者通过 Pull Request 提交改进，系统自动创建预览分支。<br>
                        切换前会先检测该版本能否加载，不可用的不会让你点进去。
                    </div>
                </div>

                <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                    <div>
                        <div style="font-size:12px;color:#6b7280;">当前版本</div>
                        <div style="font-family:monospace;font-size:14px;font-weight:600;color:#374151;">${cur === 'main' ? '🏠 官方版 (main)' : '🔀 ' + this.escapeHtml(cur)}</div>
                    </div>
                    ${cur !== 'main' ? '<button onclick="ui.resetToMain()" style="padding:8px 14px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:12px;">🏠 恢复官方版</button>' : ''}
                </div>

                <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                    <input type="text" id="vs-search" placeholder="🔍 搜索版本 / 作者"
                        oninput="ui._vsFilter=this.value;ui._renderVersionList();"
                        style="flex:1;min-width:160px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;">
                    <select id="vs-sort" onchange="ui._vsSort=this.value;ui._renderVersionList();"
                        style="padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff;">
                        <option value="time">按更新时间</option>
                        <option value="author">按作者</option>
                        <option value="name">按名称</option>
                    </select>
                </div>

                <div style="border-top:1px solid #e5e7eb;padding-top:12px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                        <div style="font-size:13px;font-weight:600;color:#374151;">🌟 社区版本</div>
                        <div id="vs-count" style="font-size:11px;color:#9ca3af;"></div>
                    </div>
                    <div id="version-plaza" style="max-height:400px;overflow-y:auto;">
                        <div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px;">加载中...</div>
                    </div>
                </div>

                <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e5e7eb;">
                    <details style="font-size:12px;color:#6b7280;">
                        <summary style="cursor:pointer;">⚙️ 高级：手动输入分支名</summary>
                        <div style="margin-top:8px;display:flex;gap:8px;">
                            <input type="text" id="branch-input" placeholder="preview/author/feature-name"
                                style="flex:1;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;font-family:monospace;">
                            <button onclick="ui.switchBranch()" style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">加载</button>
                        </div>
                    </details>
                </div>

                <div id="vs-status" style="display:none;margin-top:12px;font-size:12px;"></div>
            </div>
        `;
        this.showModal('🌐 版本广场', body, '', true);
        this.loadVersionPlaza();
    }

    _vsStatus(msg, color) {
        const el = document.getElementById('vs-status');
        if (!el) return;
        el.style.display = msg ? 'block' : 'none';
        el.style.color = color || '#6b7280';
        el.innerHTML = msg || '';
    }

    /**
     * 探测某个分支在 jsdelivr 上是否真的能取到资源。
     *
     * 拿 css/style.css 做探针：它是 index.html 里第一个从分支加载的东西，
     * 它 404 就说明整套都加载不了。
     */
    async _probeBranch(branch) {
        const url = 'https://cdn.jsdelivr.net/gh/Cool-zimo/github_drive@' +
                    encodeURIComponent(branch) + '/css/style.css';
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
            clearTimeout(timer);
            return { ok: r.ok, status: r.status };
        } catch (e) {
            return { ok: false, status: 0, error: String(e && e.message || e) };
        }
    }

    async loadVersionPlaza() {
        const plazaEl = document.getElementById('version-plaza');
        if (!plazaEl) return;

        let manifest = { branches: [] };
        try {
            const res = await fetch('https://raw.githubusercontent.com/Cool-zimo/github_drive/main/preview-branches.json?t=' + Date.now());
            if (res.ok) manifest = await res.json();
        } catch (e) { /* 清单拿不到就只用 API 结果 */ }

        const meta = new Map();
        for (const b of (manifest.branches || [])) {
            if (b && typeof b.branch === 'string') meta.set(b.branch, b);
        }

        // ── 用 API 列出真实存在的 preview/* 分支 ──
        // 清单文件漏了 10 个分支（实际 22 个，清单只有 12 个），
        // 光看清单会少一半可选版本。
        const found = new Map();
        try {
            const app = this.app;
            const user = app && app.storage ? app.storage.getUser() : null;
            if (user && app.api && app.api.request) {
                const list = await app.api.request(
                    '/repos/Cool-zimo/github_drive/branches?per_page=100');
                for (const b of (list || [])) {
                    if (!b.name || b.name.indexOf('preview/') !== 0) continue;
                    if (!this._safeBranch(b.name)) continue;
                    found.set(b.name, { branch: b.name });
                }
            }
        } catch (e) { /* 没登录就退回清单 */ }

        for (const k of meta.keys()) if (!found.has(k)) found.set(k, meta.get(k));

        this._vsList = Array.from(found.values()).map(b => {
            const m = meta.get(b.branch) || {};
            const seg = b.branch.split('/');
            return {
                branch: b.branch,
                name: m.name || (seg[seg.length - 1] || b.branch),
                author: m.author || (seg.length >= 3 ? seg[1] : 'unknown'),
                description: m.description || '',
                version: m.version || '',
                prNumber: m.prNumber || null,
                updatedAt: m.updatedAt || '',
                probe: null          // 探测结果，渲染后再补
            };
        });

        this._renderVersionList();

        // ── 后台并发探活，结果逐个回填 ──
        // 22 个分支逐个探太慢，并发 6；每个只探一次，结果缓存在对象上
        const queue = this._vsList.slice();
        const worker = async () => {
            while (queue.length) {
                const item = queue.shift();
                item.probe = await this._probeBranch(item.branch);
                const badge = document.getElementById('vs-badge-' + this._vsIdxOf(item));
                if (badge) badge.outerHTML = this._vsBadge(item);
            }
        };
        await Promise.all([0, 0, 0, 0, 0, 0].map(worker));
        this._renderVersionList();
    }

    _vsIdxOf(item) { return this._vsList.indexOf(item); }

    _vsBadge(item) {
        const p = item.probe;
        if (!p) return '<span id="vs-badge-' + this._vsIdxOf(item) +
            '" style="font-size:11px;color:#9ca3af;">检测中…</span>';
        return p.ok
            ? '<span id="vs-badge-' + this._vsIdxOf(item) +
              '" style="font-size:11px;color:#059669;background:#ecfdf5;padding:2px 8px;border-radius:10px;">✓ 可加载</span>'
            : '<span id="vs-badge-' + this._vsIdxOf(item) +
              '" style="font-size:11px;color:#dc2626;background:#fef2f2;padding:2px 8px;border-radius:10px;" title="HTTP ' +
              (p.status || '错误') + '">✗ 不可用</span>';
    }

    _renderVersionList() {
        const plazaEl = document.getElementById('version-plaza');
        if (!plazaEl || !this._vsList) return;

        const q = (this._vsFilter || '').trim().toLowerCase();
        let list = this._vsList.filter(b =>
            // ★ 纵深防御：清单来自 PR 可控的 preview-branches.json，
            //   渲染处虽然已经逐字段 esc() 转义（所以不构成 XSS），
            //   但不合法的名字本来就不该出现在列表里 ——
            //   一个 "preview/x');fetch(...)//" 出现在界面上，
            //   用户会以为是真版本而点它。过滤比转义更靠前一步。
            !!this._safeBranch(b.branch) &&
            (!q || b.branch.toLowerCase().includes(q) ||
            (b.name || '').toLowerCase().includes(q) ||
            (b.author || '').toLowerCase().includes(q) ||
            (b.description || '').toLowerCase().includes(q)));

        const sort = this._vsSort || 'time';
        list.sort((a, b) => {
            if (sort === 'author') return String(a.author).localeCompare(String(b.author)) ||
                                           String(a.branch).localeCompare(String(b.branch));
            if (sort === 'name') return String(a.name).localeCompare(String(b.name));
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) ||
                   String(a.branch).localeCompare(String(b.branch));
        });

        const cnt = document.getElementById('vs-count');
        if (cnt) cnt.textContent = '共 ' + list.length + ' 个' +
            (list.length !== this._vsList.length ? '（总 ' + this._vsList.length + '）' : '');

        if (!list.length) {
            plazaEl.innerHTML = '<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px;">' +
                (this._vsList.length ? '没有匹配的版本' : '暂无社区版本<br><span style="font-size:11px;">成为第一个贡献者吧！</span>') +
                '</div>';
            return;
        }

        const cur = localStorage.getItem('gd_custom_branch') || 'main';
        const esc = this.escapeHtml.bind(this);

        plazaEl.innerHTML = list.map((b, i) => {
            const isCurrent = cur === b.branch;
            const bad = b.probe && b.probe.ok === false;
            return `
            <div data-branch="${esc(b.branch)}" data-idx="${this._vsIdxOf(b)}"
                style="padding:12px;border:1px solid ${isCurrent ? '#2563eb' : '#e5e7eb'};border-radius:8px;margin-bottom:8px;cursor:${bad ? 'not-allowed' : 'pointer'};background:${isCurrent ? '#eff6ff' : (bad ? '#fafafa' : '#fff')};opacity:${bad ? '0.65' : '1'};"
                onmouseover="if(!${bad}){this.style.borderColor='#2563eb';this.style.background='#f8fafc'}"
                onmouseout="this.style.borderColor='${isCurrent ? '#2563eb' : '#e5e7eb'}';this.style.background='${isCurrent ? '#eff6ff' : (bad ? '#fafafa' : '#fff')}'">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
                    <div style="font-weight:600;font-size:14px;color:#111827;min-width:0;overflow:hidden;text-overflow:ellipsis;">${esc(b.name || b.branch)}</div>
                    <div style="display:flex;gap:6px;flex-shrink:0;align-items:center;">
                        ${b.version ? '<span style="font-size:11px;background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:10px;">v' + esc(b.version) + '</span>' : ''}
                        ${this._vsBadge(b)}
                    </div>
                </div>
                <div style="font-size:12px;color:#6b7280;margin-bottom:4px;">👤 ${esc(b.author || 'unknown')}${b.prNumber ? ' · PR #' + esc(String(b.prNumber)) : ''}${b.updatedAt ? ' · ' + esc(String(b.updatedAt).slice(0, 10)) : ''}</div>
                ${b.description ? '<div style="font-size:12px;color:#374151;line-height:1.4;">' + esc(b.description) + '</div>' : ''}
                <div style="font-size:11px;color:#9ca3af;margin-top:6px;font-family:monospace;word-break:break-all;">${esc(b.branch)}</div>
                ${isCurrent ? '<div style="font-size:11px;color:#2563eb;margin-top:4px;font-weight:600;">✅ 当前使用中</div>' : ''}
            </div>`;
        }).join('');

        plazaEl.querySelectorAll('[data-branch]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.getAttribute('data-idx'), 10);
                const item = this._vsList[idx];
                if (item && item.probe && item.probe.ok === false) {
                    this._vsStatus('✗ 该版本目前无法加载（HTTP ' + (item.probe.status || '错误') +
                        '），切换会导致页面打不开。已阻止。', '#dc2626');
                    return;
                }
                this.loadVersion(el.getAttribute('data-branch'));
            });
        });
    }

    /**
     * 真正切换。写入 localStorage 之前必须探活 ——
     * 一旦写进去又加载不出来，页面就白屏了，而白屏里没有设置页可点。
     */
    async loadVersion(branch) {
        const safe = this._safeBranch(branch);
        if (!safe) {
            this._vsStatus('✗ 分支名不合法，已忽略：' + String(branch).slice(0, 80), '#dc2626');
            return;
        }
        if (safe === (localStorage.getItem('gd_custom_branch') || 'main')) {
            this._vsStatus('已经是当前版本了', '#6b7280');
            return;
        }

        this._vsStatus('正在检测「' + safe + '」能否加载…', '#6b7280');
        const probe = await this._probeBranch(safe);
        if (!probe.ok) {
            this._vsStatus('✗ 无法加载（HTTP ' + (probe.status || '错误') +
                '）。已阻止切换 —— 这个版本现在切过去会白屏。', '#dc2626');
            return;
        }

        // ★ 记住上一个可用版本，万一新版本有问题能一键退回
        const prev = localStorage.getItem('gd_custom_branch');
        if (prev && prev !== safe) localStorage.setItem('gd_prev_branch', prev);

        localStorage.setItem('gd_custom_branch', safe);
        this._vsStatus('✓ 已切换到 ' + safe + '，正在刷新…', '#059669');
        setTimeout(() => location.reload(), 600);
    }

    async switchBranch() {
        const el = document.getElementById('branch-input');
        const raw = el ? el.value : '';
        const safe = this._safeBranch(raw);
        // ★ 旧版这里完全没校验，直接写 localStorage 拼进 CDN URL。
        //   而 loadVersion 有校验 —— 同一个功能两处标准，这就是漏洞的来源。
        if (!safe) {
            this._vsStatus('✗ 分支名不合法。只允许字母、数字、. _ / - ，且不含 ..', '#dc2626');
            return;
        }
        await this.loadVersion(safe);
    }

    resetToMain() {
        localStorage.removeItem('gd_custom_branch');
        localStorage.removeItem('gd_prev_branch');
        // 带 safe=1 绕过一切缓存与残留状态
        const u = new URL(window.location.href);
        u.search = '?safe=1';
        u.hash = '';
        window.location.replace(u.toString());
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
        // ★ 冲突弹窗被 ESC / 点遮罩关掉时，必须给出决定 ——
        //   否则 Promise 永远不 resolve，上传流程卡死在半路。
        //   按"跳过"处理：宁可不传，也不能替用户覆盖已有文件。
        if (this._conflictFallback) {
            const fb = this._conflictFallback;
            this._conflictFallback = null;
            fb();
        }
        const container = document.getElementById('modal-container');
        // 先取出旧节点，再立刻腾空容器 —— 顺序不能反，
        // 否则紧跟其后的 showModal 写进来的新弹窗会被退场定时器清掉。
        const overlay = container.querySelector('.modal-overlay');
        container.innerHTML = '';
        this._playModalExit(overlay);
    }

    /**
     * 弹窗退场动画。
     *
     * ★ 为什么不能简单写成「加 is-closing，等 180ms 再清空容器」：
     *   设置里有一批 action 是 `ui.closeModal(); ui.showStorageManager();`
     *   —— 关掉旧的、立刻开新的。延迟清空会把刚打开的新弹窗一起清掉，
     *   表现是"点了设置项，弹窗闪一下就没了"。
     *
     *   所以这里先把旧节点摘出来、挪到独立退场层，容器立刻腾空，
     *   新弹窗写进去不会被定时器误伤。
     */
    _playModalExit(overlay) {
        if (!overlay) return;
        try {
            if (window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

            let layer = document.getElementById('modal-exit-layer');
            if (!layer) {
                layer = document.createElement('div');
                layer.id = 'modal-exit-layer';
                document.body.appendChild(layer);
            }
            // 同一时刻只留一个退场节点，否则连续开关会层层堆叠
            layer.innerHTML = '';

            overlay.classList.add('is-closing');
            layer.appendChild(overlay);
            setTimeout(() => { try { overlay.remove(); } catch (e) {} }, 260);
        } catch (e) { /* 动画失败不影响关闭本身 */ }
    }

    /** 上传列表里把某个文件标成"已跳过" */
    markUploadSkipped(name) {
        const el = document.querySelector(`[data-upload-name="${CSS.escape(name)}"]`);
        if (el) {
            el.style.opacity = '0.5';
            const tag = document.createElement('span');
            tag.textContent = '已跳过（同名）';
            tag.style.cssText = 'font-size:11px;color:#92400e;margin-left:6px;';
            el.appendChild(tag);
        }
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
     * 同名文件冲突弹窗（仿 Windows 资源管理器）
     *
     * @param {{name,newSize,newDate,oldSize,oldDate,remaining}} info
     * @returns {Promise<{action:'replace'|'skip'|'rename', applyAll:boolean}>}
     */
    showFileConflict(info) {
        return new Promise((resolve) => {
            const fmt = (b) => {
                if (!b && b !== 0) return '—';
                const k = 1024, u = ['B', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(b) / Math.log(k));
                return (b / Math.pow(k, i)).toFixed(1) + ' ' + u[i];
            };
            const dt = (d) => {
                if (!d) return '—';
                try {
                    return d.toLocaleString(undefined, {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit'
                    });
                } catch (e) { return '—'; }
            };
            const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

            const name = esc(info.name);
            const body = `
                <div style="display:flex;gap:14px;align-items:flex-start;">
                    <div style="font-size:36px;line-height:1;">⚠️</div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:14px;color:#111827;margin-bottom:12px;word-break:break-all;">
                            此位置已存在名为 <b>「${name}」</b> 的文件
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px;">
                                <div style="font-size:11px;color:#6b7280;margin-bottom:6px;">目标中的文件</div>
                                <div style="font-size:13px;font-weight:600;color:#374151;word-break:break-all;">${name}</div>
                                <div style="font-size:12px;color:#6b7280;margin-top:6px;">${fmt(info.oldSize)}</div>
                                <div style="font-size:12px;color:#9ca3af;margin-top:2px;">${dt(info.oldDate)}</div>
                            </div>
                            <div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;">
                                <div style="font-size:11px;color:#6b7280;margin-bottom:6px;">正在上传的文件</div>
                                <div style="font-size:13px;font-weight:600;color:#374151;word-break:break-all;">${name}</div>
                                <div style="font-size:12px;color:#6b7280;margin-top:6px;">${fmt(info.newSize)}</div>
                                <div style="font-size:12px;color:#9ca3af;margin-top:2px;">${dt(info.newDate)}</div>
                            </div>
                        </div>
                        ${info.remaining ? `<div style="margin-top:12px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;">还有 ${info.remaining} 个同名文件待处理</div>` : ''}
                        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer;font-size:13px;color:#374151;">
                            <input type="checkbox" id="cf-apply-all" style="width:15px;height:15px;cursor:pointer;">
                            <span>对之后所有冲突执行此操作</span>
                        </label>
                    </div>
                </div>
            `;
            const finish = (action) => {
                // ★ 必须先撤掉 fallback 再关弹窗。
                //   closeModal() 会触发 _conflictFallback（处理 ESC/取消），
                //   而它 resolve 的是 'skip' —— Promise 一旦落定就改不了，
                //   于是点"替换"也变成"跳过"（实测确实如此）。
                if (this._conflictDone) return;
                this._conflictDone = true;
                const applyAll = !!document.getElementById('cf-apply-all')?.checked;
                this._conflictFallback = null;
                this.closeModal();
                resolve({ action, applyAll });
            };
            this._conflictDone = false;
            // ★ 三个选项都要挂到 window：onclick 里访问不到闭包里的 finish
            window.__gdConflictPick = finish;
            const btns = `
                <button class="btn-secondary" onclick="window.__gdConflictPick('rename')">保留两个文件</button>
                <button class="btn-secondary" onclick="window.__gdConflictPick('skip')">跳过此文件</button>
                <button class="btn-primary" onclick="window.__gdConflictPick('replace')">替换目标中的文件</button>
            `;
            this.showModal('替换或跳过文件', body, btns);
            // 关闭弹窗（取消）时按"跳过"处理，绝不能默认覆盖
            // 关闭弹窗（ESC / 点遮罩 / 取消）时按"跳过"处理，绝不能默认覆盖
            this._conflictFallback = () => {
                if (this._conflictDone) return;
                this._conflictDone = true;
                this._conflictFallback = null;
                resolve({ action: 'skip', applyAll: false });
            };
        });
    }

    /**
     * 分享模态框
     */
    showShareModal(files) {
        const fileNames = files.map(f => f.name).join(', ');
        const folderCount = files.filter(f => f.isFolder).length;
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
                    <label>${folderCount ? `要分享的条目（${files.length} 个，含 ${folderCount} 个文件夹）` : `要分享的文件（${files.length} 个）`}</label>
                    <div style="background:#f6f8fa;padding:12px;border-radius:6px;font-size:13px;max-height:120px;overflow-y:auto;">
                        ${files.map(f => `<div>${f.isFolder ? '📁' : '📄'} ${f.name}</div>`).join('')}
                    </div>
                    ${folderCount ? `<p class="form-hint">文件夹会包含其中所有文件，并保持目录结构</p>` : ''}
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
        this._lastSharePct = 0;
        if (typeof TaskDock !== 'undefined') {
            this._shareTaskId = TaskDock.create({
                type: 'share',
                title: `正在分享 ${fileCount} 个文件`,
                single: true,
                items: [],
                note: '准备中…',
                expand: true
            });
            this._shareProgressOpen = true;
            return;
        }
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
        if (typeof TaskDock !== 'undefined' && this._shareTaskId) {
            TaskDock.setPercent(this._shareTaskId, percent, msg);
            return;
        }
        if (!this._shareProgressOpen) return;
        let pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
        /**
         * ★ 进度只增不减。
         *   分享是多阶段流程，各阶段自己算百分比，一旦某个阶段从较小的值
         *   起步（例如读取刚结束 32%，转去上传又从 10% 报），进度条会往回缩，
         *   看着就像卡住甚至坏了。这里兜底保证单调。
         */
        this._lastSharePct = this._lastSharePct || 0;
        if (pct < this._lastSharePct) pct = this._lastSharePct;
        this._lastSharePct = pct;

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
    closeShareProgress(failed, msg) {
        if (typeof TaskDock !== 'undefined' && this._shareTaskId) {
            TaskDock.finish(this._shareTaskId, failed ? (msg || '分享失败') : null);
            this._shareTaskId = null;
            this._shareProgressOpen = false;
            return;
        }
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
        // ★ switchView 对非文件视图会设置 fileList.style.display='none'（内联样式，
        //   优先级高于 CSS 类）。分享列表复用的是同一个容器，不把内联样式清掉的话，
        //   数据全都渲染好了却一个字都看不见 —— 表现就是"我的分享一直是空的"。
        //   实测：容器里有 12 张卡片、宽高却是 0×0。
        container.style.display = '';
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
        // 同上：switchView 隐藏了容器，这里必须恢复，否则发现分享也是空白
        container.style.display = '';
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

    /**
     * 属性值转义 —— 比 escapeHtml 多转引号
     *
     * ★ 为什么不能直接用 escapeHtml：
     *   textContent → innerHTML 的往返只转 & < >，**不转 " 和 '**。
     *   放进 <div title="${x}"> 或 onclick="f('${x}')" 里，
     *   一个引号就能闭合属性、注入新属性或事件。
     *   凡是往 HTML 属性里插值，必须用这个。
     */
    escapeAttr(text) {
        return this.escapeHtml(text == null ? '' : String(text))
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
    /**
     * 打开插件。
     *
     * 以前是全屏覆盖层（.plugin-overlay），一开就把网盘整个挡住，
     * 想一边跑插件一边翻文件根本不行。现在改成和上传/分享同款的可拖动窗口：
     * 拖到侧边收成小窗，点开继续，多个插件各占一个窗口，还能全屏。
     *
     * ★ iframe 创建后交给 TaskDock，之后**不再移动**——
     *   移动 iframe 会导致它重新加载，插件里填了一半的东西会全丢。
     */
    showPluginRunner(plugin) {
        // 加随机后缀：同一毫秒内连开两个插件时，
        // 纯 Date.now() 会生成相同 id，后开的顶掉先开的记录
        const id = 'plugin-runner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

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

        let src = plugin.externalUrl || null;
        let blobUrl = null;
        if (!src) {
            const htmlWithI18n = plugin.html.replace('<head>', '<head>' + i18nScript).replace('<body>', i18nScript + '<body>');
            const finalHtml = htmlWithI18n === plugin.html ? i18nScript + plugin.html : htmlWithI18n;
            const blob = new Blob([finalHtml], { type: 'text/html' });
            blobUrl = URL.createObjectURL(blob);
            src = blobUrl;
        }

        const frame = document.createElement('iframe');
        frame.className = 'plugin-frame';
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        frame.src = src;

        // 每个插件层独立持有 handler，互不覆盖
        const messageHandler = (event) => {
            if (event.data && event.data.type === 'gd-api') {
                this.app.handlePluginMessage(event, plugin.id);
            }
        };
        window.addEventListener('message', messageHandler);

        this._pluginRunners = this._pluginRunners || {};
        this._pluginRunners[id] = { messageHandler, url: blobUrl, pluginId: plugin.id };

        // 交给任务坞托管：窗口由它创建，iframe 只是被挂进去
        const winId = (typeof TaskDock !== 'undefined' && TaskDock.openPlugin)
            ? TaskDock.openPlugin({
                title: plugin.name,
                icon: plugin.icon || (plugin.type === 'game' ? '🎮' : '🔌'),
                mount: frame,
                onClose: () => this.closePluginRunner(id, blobUrl)
            })
            : null;
        this._pluginRunners[id].winId = winId;

        // 任务坞缺失时兜底：退回原来的全屏层，保证插件至少能开
        if (!winId) this._mountPluginOverlay(id, plugin, src, blobUrl);
        return id;
    }

    /**
     * 挂载全屏插件层（兜底路径，任务坞不可用时才走这里）
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
        if (Object.keys(this._pluginRunners).length <= 1) {
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
        this._pluginRunners[modalId].overlay = overlay;

        // ESC 关闭：全屏层最自然的退出方式
        const keyHandler = (e) => {
            if (e.key === 'Escape') this.closePluginRunner(modalId, blobUrl || '');
        };
        document.addEventListener('keydown', keyHandler);
        this._pluginRunners[modalId].keyHandler = keyHandler;
    }

    /**
     * 关闭插件
     * @param {string} id 插件运行 id
     * @param {string} url blob 地址（可空；外部 URL 插件没有）
     */
    closePluginRunner(id, url) {
        const rec = this._pluginRunners && this._pluginRunners[id];
        if (rec) {
            window.removeEventListener('message', rec.messageHandler);
            if (rec.keyHandler) document.removeEventListener('keydown', rec.keyHandler);
            if (rec.overlay && rec.overlay.parentNode) rec.overlay.parentNode.removeChild(rec.overlay);
            delete this._pluginRunners[id];
            url = url || rec.url;
        }
        // blob URL 在所有路径下都要回收，否则内存泄漏
        if (url) URL.revokeObjectURL(url);

        // 兜底层的滚动锁要恢复；窗口模式本来就没锁，这里会被自然跳过
        const anyOverlay = this._pluginRunners &&
            Object.values(this._pluginRunners).some(r => r.overlay);
        if (!anyOverlay && this._prevBodyOverflow !== null && this._prevBodyOverflow !== undefined) {
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
        const fileList = Array.isArray(files) ? files : [files];
        // ★ 改走任务坞：居中大弹窗会挡住整个界面，98 个文件的时候根本没法
        //   同时看文件列表。任务坞可以拖到侧边变成小窗。
        if (typeof TaskDock !== 'undefined') {
            this._uploadTaskId = TaskDock.create({
                type: 'upload',
                title: `正在上传（${fileList.length} 个文件）`,
                items: fileList.map(f => f.name || f.webkitRelativePath || '文件'),
                expand: true
            });
            this._uploadTotalFiles = fileList.length;
            return;
        }
        // 兜底：TaskDock 没加载出来时退回原来的弹窗
        const existing = document.getElementById('upload-progress-modal');
        if (existing) existing.remove();
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
        if (typeof TaskDock !== 'undefined' && this._uploadTaskId) {
            TaskDock.updateItem(this._uploadTaskId, index, percent);
            return;
        }
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
        if (typeof TaskDock !== 'undefined' && this._uploadTaskId) {
            TaskDock.setItemDone(this._uploadTaskId, index);
            return;
        }
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

    hideUploadProgress(failed, msg) {
        if (typeof TaskDock !== 'undefined' && this._uploadTaskId) {
            TaskDock.finish(this._uploadTaskId, failed ? (msg || '上传失败') : null);
            this._uploadTaskId = null;
            return;
        }
        const modal = document.getElementById('upload-progress-modal');
        if (!modal) return;
        modal.classList.add('closing');
        setTimeout(() => modal.remove(), 300);
    }
    
    // 显示下载进度
    showDownloadProgress(fileName) {
        if (typeof TaskDock !== 'undefined') {
            this._downloadTaskId = TaskDock.create({
                type: 'download',
                title: fileName,
                items: [fileName],
                expand: true
            });
            return;
        }
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
        if (typeof TaskDock !== 'undefined' && this._downloadTaskId) {
            TaskDock.updateItem(this._downloadTaskId, 0, percent);
            if (current && total) TaskDock.setNote(this._downloadTaskId, `分片 ${current}/${total}`);
            return;
        }
        const bar = document.getElementById('download-bar');
        const percentEl = document.getElementById('download-percent');
        const chunkInfo = document.getElementById('download-chunk-info');
        if (bar) bar.style.width = percent + '%';
        if (percentEl) percentEl.textContent = percent + '%';
        if (chunkInfo) chunkInfo.textContent = `分片 ${current}/${total}`;
    }
    
    hideDownloadProgress(failed, msg) {
        if (typeof TaskDock !== 'undefined' && this._downloadTaskId) {
            TaskDock.finish(this._downloadTaskId, failed ? (msg || '下载失败') : null);
            this._downloadTaskId = null;
            return;
        }
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
            <button class="toast-close" onclick="var t=this.parentElement;t.classList.add('is-out');setTimeout(function(){t.remove()},260)">×</button>
        `;
        container.appendChild(toast);
        setTimeout(() => {
            // 用 class 而不是内联样式：内联优先级高于 CSS，
            // 会盖掉 prefers-reduced-motion 里"不要动画"的兜底。
            toast.classList.add('is-out');
            setTimeout(() => { try { toast.remove(); } catch (e) {} }, 260);
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
