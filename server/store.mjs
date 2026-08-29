import fs from 'node:fs';
import path from 'node:path';

/**
 * Flat-file JSON store standing in for the Laravel/MySQL side.
 *
 * Tables mirror the schema in spec §10 so the Livewire drop-in and the real
 * migrations line up: agents, customers, call_records, recordings.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = this._load();
    this._writeTimer = null;
  }

  _load() {
    if (fs.existsSync(this.file)) {
      try {
        return JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        console.warn(`[store] ${this.file} is corrupt, reseeding:`, err.message);
      }
    }
    const seeded = seed();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(seeded, null, 2));
    return seeded;
  }

  /** Debounced so a burst of CDR writes doesn't hammer the disk. */
  save() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }, 150);
  }

  // ---- Agents ------------------------------------------------------------

  findAgentByEmail(email) {
    return this.data.agents.find((a) => a.email.toLowerCase() === String(email).toLowerCase()) ?? null;
  }

  findAgent(id) {
    return this.data.agents.find((a) => a.id === id) ?? null;
  }

  // ---- Customers (spec §5) ----------------------------------------------

  /**
   * Look a CLI up. Local numbers arrive in several formats (0772…, +94772…,
   * 94772…), so compare on the last 9 digits — the same trick the real CRM
   * will need.
   */
  findCustomerByPhone(phone) {
    const key = normalisePhone(phone);
    if (!key) return null;
    const customer = this.data.customers.find((c) =>
      [c.phone, ...(c.alt_phones ?? [])].some((p) => normalisePhone(p) === key));
    if (!customer) return null;

    const calls = this.data.call_records.filter((r) => normalisePhone(r.customer_number) === key);
    const answered = calls.filter((c) => c.answer_time);
    return {
      ...customer,
      previous_calls: calls.length,
      last_call: calls.length ? formatDate(calls[calls.length - 1].start_time) : null,
      total_talk_time: answered.reduce((sum, c) => sum + (c.duration || 0), 0),
    };
  }

  // ---- Call records (spec §10) ------------------------------------------

  upsertCallRecord(record) {
    const idx = this.data.call_records.findIndex((r) => r.call_id === record.call_id);
    if (idx >= 0) {
      this.data.call_records[idx] = { ...this.data.call_records[idx], ...record };
    } else {
      this.data.call_records.push({ id: this.data.call_records.length + 1, ...record });
    }
    this.save();
    return this.data.call_records[idx >= 0 ? idx : this.data.call_records.length - 1];
  }

  /** Match an Asterisk CDR to the browser's record via number + time window. */
  attachAsteriskCdr(cdr) {
    const key = normalisePhone(cdr.src) || normalisePhone(cdr.dst);
    const candidates = this.data.call_records
      .filter((r) => !r.asterisk_unique_id)
      .filter((r) => normalisePhone(r.customer_number) === key)
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    const target = candidates[0];
    if (target) {
      Object.assign(target, {
        asterisk_unique_id: cdr.call_id,
        recording_path: cdr.recording ? `recordings/${cdr.recording}` : null,
        billsec: Number(cdr.billsec) || 0,
        disposition: cdr.disposition,
      });
    } else {
      // Calls that never reached the browser (e.g. echo test) still get a row.
      this.data.call_records.push({
        id: this.data.call_records.length + 1,
        call_id: cdr.call_id,
        asterisk_unique_id: cdr.call_id,
        direction: 'unknown',
        customer_number: cdr.src,
        extension: cdr.dst,
        start_time: cdr.start,
        end_time: cdr.end,
        duration: Number(cdr.duration) || 0,
        billsec: Number(cdr.billsec) || 0,
        disposition: cdr.disposition,
        recording_path: cdr.recording ? `recordings/${cdr.recording}` : null,
        source: 'asterisk',
      });
    }
    this.save();
    return target ?? this.data.call_records[this.data.call_records.length - 1];
  }

  recentCalls({ limit = 25, extension } = {}) {
    return this.data.call_records
      .filter((r) => !extension || r.extension === extension)
      .slice()
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
      .slice(0, limit);
  }

  get branding() {
    return this.data.branding;
  }
}

export function normalisePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  // Compare on the subscriber part so 0772615908 == +94772615908 == 94772615908.
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Seed data lifted from the spec's own examples so the demo looks familiar. */
function seed() {
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 86400000).toISOString();

  return {
    branding: {
      logo: '/assets/logo.svg',
      company_name: 'Auso World',
      primary_color: '#0f766e',
      show_powered_by: true,
      theme: 'default',
    },
    agents: [
      { id: 1, name: 'Nimal Perera', email: 'agent1@ausoworld.com', password: 'secret', extension: '2001', role: 'agent', auto_answer: false },
      { id: 2, name: 'Kamala Silva', email: 'agent2@ausoworld.com', password: 'secret', extension: '2002', role: 'agent', auto_answer: false },
      { id: 3, name: 'Ruwan Fernando', email: 'agent3@ausoworld.com', password: 'secret', extension: '2003', role: 'agent', auto_answer: true },
      { id: 4, name: 'Ayesha Jayawardena', email: 'agent4@ausoworld.com', password: 'secret', extension: '2004', role: 'agent', auto_answer: false },
      { id: 5, name: 'Supervisor', email: 'supervisor@ausoworld.com', password: 'secret', extension: '2005', role: 'supervisor', auto_answer: false },
    ],
    customers: [
      {
        id: 1, name: 'ABC Company', company: 'ABC Company (Pvt) Ltd',
        phone: '0772615908', alt_phones: ['+94772615908'],
        email: 'accounts@abc.lk', city: 'Colombo',
        account_number: 'ACC-1043', notes: 'Priority account — escalate to supervisor 2005.',
      },
      {
        id: 2, name: 'Sunil Rathnayake', company: 'Rathnayake Motors',
        phone: '0711234567', alt_phones: [],
        email: 'sunil@rathnayake.lk', city: 'Kandy',
        account_number: 'ACC-2210', notes: 'Prefers a callback after 5pm.',
      },
      {
        id: 3, name: 'Global Traders', company: 'Global Traders Ltd',
        phone: '0119876543', alt_phones: ['0779876543'],
        email: 'info@globaltraders.lk', city: 'Negombo',
        account_number: 'ACC-3387', notes: 'Open dispute on invoice INV-8891.',
      },
    ],
    call_records: [
      { id: 1, call_id: 'seed-1', direction: 'inbound', customer_number: '0772615908', extension: '2002', start_time: daysAgo(1), answer_time: daysAgo(1), end_time: daysAgo(1), duration: 212, disposition: 'ANSWERED', source: 'seed' },
      { id: 2, call_id: 'seed-2', direction: 'outbound', customer_number: '0772615908', extension: '2001', start_time: daysAgo(3), answer_time: daysAgo(3), end_time: daysAgo(3), duration: 96, disposition: 'ANSWERED', source: 'seed' },
      { id: 3, call_id: 'seed-3', direction: 'inbound', customer_number: '0711234567', extension: '2002', start_time: daysAgo(5), answer_time: null, end_time: daysAgo(5), duration: 0, disposition: 'NO ANSWER', source: 'seed' },
    ],
  };
}
