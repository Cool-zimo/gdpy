/**
 * GitHub Drive - 浏览器扩展通信模块
 * 功能：
 * 1. 检测扩展是否已安装
 * 2. 与扩展通信（获取 Token、API 代理）
 * 3. 如果扩展可用，优先使用扩展进行 API 请求
 */

class ExtensionHelper {
    constructor() {
        this.installed = false;
        this.version = null;
        this._messageId = 0;
        this._pendingRequests = new Map();
        // --- END ---
        this._init();
    }

    _init() {
        // 监听来自扩展的消息
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const message = event.data;
            if (!message || message.source !== 'github-drive-extension') return;

            // 扩展加载通知
            if (message.type === 'EXTENSION_LOADED') {
                this.installed = true;
                this.version = message.version;
                console.log('[Extension] 扩展已安装，版本:', this.version);
                return;
            }

            // 响应消息
            if (message.type && message.type.endsWith('_RESPONSE')) {
                const requestId = message.requestId;
                const resolve = this._pendingRequests.get(requestId);
                if (resolve) {
                    this._pendingRequests.delete(requestId);
                    resolve(message);
                }
            }
        });


        // 检测扩展是否已安装（通过 window 标记）
        if (window.__GITHUB_DRIVE_EXTENSION__) {
            this.installed = true;
            this.version = window.__GITHUB_DRIVE_EXTENSION_VERSION__;
            console.log('[Extension] 检测到扩展已安装，版本:', this.version);
        } else {
            // 延迟检测（等待 content script 注入）
            setTimeout(() => {
                if (window.__GITHUB_DRIVE_EXTENSION__) {
                    this.installed = true;
                    this.version = window.__GITHUB_DRIVE_EXTENSION_VERSION__;
                    console.log('[Extension] 延迟检测到扩展已安装');
                } else {
                    console.log('[Extension] 未检测到扩展，将使用纯前端模式');
                }
            }, 1000);
        }
    }

    /**
     * 发送消息给扩展
     */
    _sendMessage(type, data = {}) {
        return new Promise((resolve, reject) => {
            if (!this.installed) {
                reject(new Error('扩展未安装'));
                return;
            }

            const requestId = ++this._messageId;
            this._pendingRequests.set(requestId, resolve);

            window.postMessage({
                source: 'github-drive-page',
                type: type,
                requestId: requestId,
                ...data
            }, '*');

            // 超时处理
            setTimeout(() => {
                if (this._pendingRequests.has(requestId)) {
                    this._pendingRequests.delete(requestId);
                    reject(new Error('扩展响应超时'));
                }
            }, 30000);
        });
    }

    /**
     * 检测扩展是否可用
     */
    isAvailable() {
        return this.installed;
    }

    /**
     * 获取扩展版本
     */
    getVersion() {
        return this.version;
    }

    /**
     * 获取存储在扩展中的 Token
     */
    async getToken() {
        try {
            const response = await this._sendMessage('GET_TOKEN');
            return response.token || null;
        } catch (e) {
            console.warn('[Extension] 获取 Token 失败:', e.message);
            return null;
        }
    }

    /**
     * 保存 Token 到扩展
     */
    async setToken(token) {
        try {
            const response = await this._sendMessage('SET_TOKEN', { token });
            return response.ok;
        } catch (e) {
            console.warn('[Extension] 保存 Token 失败:', e.message);
            return false;
        }
    }

    /**
     * 清除扩展中的 Token
     */
    async clearToken() {
        try {
            const response = await this._sendMessage('CLEAR_TOKEN');
            return response.ok;
        } catch (e) {
            console.warn('[Extension] 清除 Token 失败:', e.message);
            return false;
        }
    }

    /**
     * 获取用户信息
     */
    async getUser() {
        try {
            const response = await this._sendMessage('GET_USER');
            return response.user || null;
        } catch (e) {
            console.warn('[Extension] 获取用户信息失败:', e.message);
            return null;
        }
    }

    /**
     * 通过扩展代理 GitHub API 请求
     */
    async apiRequest(method, path, body = null, headers = {}, useToken = true) {
        try {
            const response = await this._sendMessage('API_REQUEST', {
                method,
                path,
                body,
                headers,
                useToken
            });
            return response;
        } catch (e) {
            console.warn('[Extension] API 请求失败:', e.message);
            throw e;
        }
    }

}

// 创建全局实例
const extensionHelper = new ExtensionHelper();