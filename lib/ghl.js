// Thin GHL v2 API client for one sub-account, using a Private Integration token.
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

const FIELD_KEYS = [
  'funded_amount', 'funded_date', 'factor_rate', 'rtr', 'payment_frequency', 'term_length', 'term_unit',
  'payment_amount', 'payment_status', 'missed_payments',
  'commission_pct', 'commission_amount',
  'opener_agent', 'opener_pct', 'opener_amount',
  'closer_1_agent', 'closer_1_pct', 'closer_1_amount',
  'closer_2_agent', 'closer_2_pct', 'closer_2_amount',
  'closer_3_agent', 'closer_3_pct', 'closer_3_amount',
];

class GHL {
  constructor({ token, locationId }) {
    this.token = token;
    this.locationId = locationId;
    this.fieldMap = null; // key -> id
    this.idToKey = null;  // id -> key
  }

  async req(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: VERSION,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`GHL ${method} ${path} → ${res.status}: ${json.message || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async loadFields() {
    const j = await this.req('GET', `/locations/${this.locationId}/customFields?model=opportunity`);
    const list = j.customFields || [];
    this.fieldMap = {};
    this.idToKey = {};
    for (const cf of list) {
      const key = String(cf.fieldKey || '').replace(/^opportunity\./, '');
      if (FIELD_KEYS.includes(key)) {
        this.fieldMap[key] = cf.id;
        this.idToKey[cf.id] = key;
      }
    }
    const missing = FIELD_KEYS.filter((k) => !this.fieldMap[k]);
    return { found: Object.keys(this.fieldMap).length, missing };
  }

  async listUsers() {
    try {
      const j = await this.req('GET', `/users/?locationId=${this.locationId}`);
      return (j.users || []).map((u) => ({ id: u.id, name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() }));
    } catch { return []; }
  }

  async listPipelines() {
    const j = await this.req('GET', `/opportunities/pipelines?locationId=${this.locationId}`);
    return j.pipelines || [];
  }

  // Pages through every opportunity in the location.
  async allOpportunities() {
    const out = [];
    let startAfter, startAfterId;
    for (let guard = 0; guard < 200; guard++) {
      const qs = new URLSearchParams({ location_id: this.locationId, limit: '100' });
      if (startAfter) qs.set('startAfter', startAfter);
      if (startAfterId) qs.set('startAfterId', startAfterId);
      const j = await this.req('GET', `/opportunities/search?${qs}`);
      const batch = j.opportunities || [];
      out.push(...batch);
      const meta = j.meta || {};
      if (!batch.length || !meta.startAfterId || out.length >= (meta.total || Infinity)) break;
      startAfter = meta.startAfter; startAfterId = meta.startAfterId;
    }
    return out;
  }

  // Flatten an opportunity's custom fields to { key: value }.
  flatten(opp) {
    const f = {};
    for (const cf of opp.customFields || []) {
      const key = this.idToKey[cf.id];
      if (!key) continue;
      const v = cf.fieldValue ?? cf.fieldValueString ?? cf.fieldValueNumber ?? cf.fieldValueDate
        ?? (Array.isArray(cf.fieldValueArray) ? cf.fieldValueArray[0] : undefined) ?? cf.value;
      f[key] = v;
    }
    return f;
  }

  async updateFields(oppId, values) {
    const customFields = Object.entries(values)
      .filter(([k]) => this.fieldMap[k])
      .map(([k, v]) => ({ id: this.fieldMap[k], field_value: v }));
    if (!customFields.length) return null;
    return this.req('PUT', `/opportunities/${oppId}`, { customFields });
  }
}

module.exports = { GHL, FIELD_KEYS };
