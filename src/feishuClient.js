const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";

export class FeishuClient {
  constructor(config) {
    this.config = config;
    this.tenantToken = "";
    this.tenantTokenExpireAt = 0;
    this.appToken = "";
    this.appTokenExpireAt = 0;
    this.tableIdCache = new Map();
  }

  isConfigured() {
    return Boolean(this.config.feishu.appId && this.config.feishu.appSecret);
  }

  async getTenantAccessToken() {
    if (!this.isConfigured()) {
      throw new Error("Feishu app credentials are not configured.");
    }
    const now = Date.now();
    if (this.tenantToken && now < this.tenantTokenExpireAt - 60_000) {
      return this.tenantToken;
    }

    const response = await fetch(`${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu token request failed: ${data.msg || response.statusText}`);
    }
    this.tenantToken = data.tenant_access_token;
    this.tenantTokenExpireAt = now + Number(data.expire || 7200) * 1000;
    return this.tenantToken;
  }

  async request(path, options = {}) {
    const token = await this.getTenantAccessToken();
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
      throw new Error(`Feishu API failed: ${data.msg || response.statusText}`);
    }
    return data;
  }

  async getAppAccessToken() {
    if (!this.isConfigured()) {
      throw new Error("Feishu app credentials are not configured.");
    }
    const now = Date.now();
    if (this.appToken && now < this.appTokenExpireAt - 60_000) {
      return this.appToken;
    }

    const response = await fetch(`${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu app token request failed: ${data.msg || response.statusText}`);
    }
    this.appToken = data.app_access_token;
    this.appTokenExpireAt = now + Number(data.expire || 7200) * 1000;
    return this.appToken;
  }

  getAuthorizationUrl({ redirectUri, state, scopes = [] }) {
    const url = new URL(`${FEISHU_BASE_URL}/authen/v1/authorize`);
    url.searchParams.set("app_id", this.config.feishu.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
    return url.toString();
  }

  async requestWithAppToken(path, body) {
    const appToken = await this.getAppAccessToken();
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu OAuth request failed: ${data.msg || response.statusText}`);
    }
    return data.data || data;
  }

  async exchangeAuthorizationCode(code) {
    return this.requestWithAppToken("/authen/v1/oidc/access_token", {
      grant_type: "authorization_code",
      code
    });
  }

  async refreshUserAccessToken(refreshToken) {
    return this.requestWithAppToken("/authen/v1/oidc/refresh_access_token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  }

  async requestWithUserToken(path, accessToken, options = {}) {
    const response = await fetch(`${FEISHU_BASE_URL}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
      throw new Error(`Feishu mailbox API failed: ${data.msg || response.statusText}`);
    }
    return data.data || data;
  }

  async listMailboxMessages({ userMailboxId = "me", accessToken, folderId, pageSize = 1, pageToken = "" }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (folderId) query.set("folder_id", folderId);
    if (pageToken) query.set("page_token", pageToken);
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/messages?${query.toString()}`,
      accessToken
    );
  }

  async listMailboxFolders({ userMailboxId = "me", accessToken }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/folders`,
      accessToken
    );
  }

  async getMailboxMessage({ userMailboxId = "me", messageId, accessToken }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    const message = encodeURIComponent(messageId);
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/messages/${message}`,
      accessToken
    );
  }

  async sendMailboxMessage({ userMailboxId = "me", accessToken, to, subject, bodyPlainText, dedupeKey }) {
    const mailbox = encodeURIComponent(userMailboxId || "me");
    return this.requestWithUserToken(
      `/mail/v1/user_mailboxes/${mailbox}/messages/send`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          subject,
          to: [{ mail_address: to }],
          body_plain_text: bodyPlainText,
          dedupe_key: dedupeKey
        })
      }
    );
  }

  async listBitableRecords(tableName, pageSize = 100, pageToken = "") {
    const appToken = this.config.bitable.appToken;
    const tableId = await this.resolveBitableTableId(tableName);
    if (!appToken || !tableId) return { skipped: true, items: [] };
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) query.set("page_token", pageToken);
    const data = await this.request(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/records?${query.toString()}`
    );
    return data.data || data;
  }

  async listAllBitableRecords(tableName, { pageSize = 100, maxRecords = 1000 } = {}) {
    const items = [];
    let pageToken = "";
    while (items.length < maxRecords) {
      const data = await this.listBitableRecords(
        tableName,
        Math.min(pageSize, maxRecords - items.length),
        pageToken
      );
      const pageItems = data.items || [];
      items.push(...pageItems);
      const nextPageToken = String(data.page_token || data.pageToken || "");
      if (!data.has_more || !nextPageToken || !pageItems.length) break;
      pageToken = nextPageToken;
    }
    return { items, total: items.length, hasMore: items.length >= maxRecords };
  }

  async resolveBitableTableId(tableName) {
    const configured = this.config.bitable.tables[tableName];
    if (configured) return configured;
    if (this.tableIdCache.has(tableName)) return this.tableIdCache.get(tableName);
    const dynamicNames = {
      projectProducts: "项目与产品插件库"
    };
    const expectedName = dynamicNames[tableName];
    if (!expectedName) return "";
    const data = await this.listBitableTables(100);
    const table = (data.items || []).find((item) => String(item.name || "") === expectedName);
    const tableId = table?.table_id || table?.id || "";
    if (tableId) this.tableIdCache.set(tableName, tableId);
    return tableId;
  }

  async listBitableTables(pageSize = 100) {
    const appToken = this.config.bitable.appToken;
    if (!appToken) return { skipped: true, items: [] };
    const data = await this.request(`/bitable/v1/apps/${appToken}/tables?page_size=${pageSize}`);
    return data.data || data;
  }

  async createBitableTable({ name, defaultViewName = "全部提交" }) {
    const appToken = this.config.bitable.appToken;
    if (!appToken) throw new Error("BITABLE_APP_TOKEN is not configured.");
    const data = await this.request(`/bitable/v1/apps/${appToken}/tables`, {
      method: "POST",
      body: JSON.stringify({
        table: {
          name,
          default_view_name: defaultViewName,
          fields: [
            { field_name: "项目ID", type: 1 }
          ]
        }
      })
    });
    return data.data || data;
  }

  async listBitableFields(tableId, pageSize = 100) {
    const appToken = this.config.bitable.appToken;
    if (!appToken || !tableId) return { skipped: true, items: [] };
    const data = await this.request(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=${pageSize}`
    );
    return data.data || data;
  }

  async createBitableField(tableId, field) {
    const appToken = this.config.bitable.appToken;
    if (!appToken || !tableId) throw new Error("Bitable app token and table id are required.");
    const data = await this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
      method: "POST",
      body: JSON.stringify(field)
    });
    return data.data || data;
  }

  async listBitableViews(tableId, pageSize = 100) {
    const appToken = this.config.bitable.appToken;
    if (!appToken || !tableId) return { skipped: true, items: [] };
    const data = await this.request(
      `/bitable/v1/apps/${appToken}/tables/${tableId}/views?page_size=${pageSize}`
    );
    return data.data || data;
  }

  async createBitableView(tableId, { name, type }) {
    const appToken = this.config.bitable.appToken;
    if (!appToken || !tableId) throw new Error("Bitable app token and table id are required.");
    const data = await this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/views`, {
      method: "POST",
      body: JSON.stringify({ view_name: name, view_type: type })
    });
    return data.data || data;
  }

  async updateBitableRecord(tableName, recordId, fields) {
    const appToken = this.config.bitable.appToken;
    const tableId = await this.resolveBitableTableId(tableName);
    if (!appToken || !tableId || !recordId) {
      throw new Error(`Missing bitable configuration or record id for ${tableName}.`);
    }
    return this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
      method: "PUT",
      body: JSON.stringify({ fields })
    });
  }

  async findCreatorByEmail(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return null;
    const data = await this.listAllBitableRecords("creators", { maxRecords: 1000 });
    for (const record of data.items || []) {
      const fields = record.fields || {};
      const values = [fields["联系方式"], fields["邮箱"], fields["Email"], fields["邮箱地址"]]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => JSON.stringify(value).toLowerCase());
      if (!values.some((value) => value.includes(normalized))) continue;
      return {
        recordId: record.record_id,
        name: String(fields["达人昵称"] || fields["达人名称"] || normalized),
        fields
      };
    }
    return null;
  }

  async createBitableRecord(tableName, fields) {
    const appToken = this.config.bitable.appToken;
    const tableId = await this.resolveBitableTableId(tableName);
    if (!appToken || !tableId) {
      throw new Error(`Missing bitable configuration for ${tableName}.`);
    }

    return this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
      method: "POST",
      body: JSON.stringify({ fields })
    });
  }

  async deleteBitableRecord(tableName, recordId) {
    const appToken = this.config.bitable.appToken;
    const tableId = await this.resolveBitableTableId(tableName);
    if (!appToken || !tableId || !recordId) return { skipped: true };
    return this.request(`/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
      method: "DELETE"
    });
  }
}
