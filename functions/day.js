// Netlify Function: day
// One day at the register, broken out the way Raz looks at it.
//
// Route: /.netlify/functions/day?store_id=store1&date=YYYY-MM-DD
//   date defaults to the most recent day that actually has sales, not
//   today — today is usually empty until the overnight sync runs, and a
//   screen of zeros looks like a broken store rather than a quiet morning.
//
// Returns: the day's take split by tender, by department and by cashier,
// with pickups and what each drawer declared.
//
// Names come from lookup tables filled from the POS itself. Where a name
// has not been recorded yet the number is shown as it is — "Department 60"
// — rather than a guess. A wrong label on a real figure is worse than no
// label, because it gets believed.

const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('./lib/guard');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

const json = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.handler = async (event) => {
  // Nobody sees any of this without signing in. Before this, the URL was
  // the only thing between a stranger and the bank position, and a URL is
  // not a secret: it is in browser history, in a chat message, on a screen
  // in a stockroom.
  const auth = await requireUser(event, supabase);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const q = event.queryStringParameters || {};
  const store_id = q.store_id || 'store1';

  try {
    let date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : null;
    if (!date) {
      const recent = await supabase.from('tender_daily')
        .select('business_date, tender_amount').eq('store_id', store_id)
        .order('business_date', { ascending: false }).limit(600);
      const money_on = {};
      (recent.data || []).forEach((r) => {
        const d = r.business_date;
        money_on[d] = (money_on[d] || 0) + Math.abs(Number(r.tender_amount) || 0);
      });
      const days = Object.keys(money_on).sort().reverse();
      // The newest day with money on it, not simply the newest day. The
      // register writes a row per tender before anyone has rung a sale, so
      // today usually exists with nothing in it. Landing there shows a
      // screen of zeros, which reads as a broken store rather than as a
      // morning that has not happened yet.
      date = days.filter((d) => money_on[d] > 0)[0] || days[0] || null;
      if (!date) return json(200, { store_id, date: null, empty: true, reason: 'No register data yet.' });
    }

    const [tenderRes, typesRes, deptRes, deptNamesRes, staffRes, syncRes] = await Promise.all([
      supabase.from('tender_daily')
        .select('employee_id, tender_id, tender_amount, tender_qty, pickup_amount, pickup_qty, declared_amount, open_float_amount, over_short_amount')
        .eq('store_id', store_id).eq('business_date', date),
      supabase.from('tender_types').select('tender_id, description, bucket, sort_order'),
      supabase.from('dept_sales')
        .select('department_id, net_sales_amount, net_sales_qty, return_sales_amount, discount_sales_amount')
        .eq('store_id', store_id).eq('business_date', date),
      supabase.from('department_names').select('department_id, name'),
      supabase.from('staff_names').select('employee_id, name'),
      supabase.from('store_sync').select('business_date, synced_at').eq('store_id', store_id).limit(1),
    ]);

    const typeOf = {};
    (typesRes.data || []).forEach((t) => { typeOf[String(t.tender_id)] = t; });
    // These two tables may not exist yet; a missing lookup is not an error,
    // it just means the figures are shown against their numbers.
    const deptName = {};
    (deptNamesRes.data || []).forEach((d) => { deptName[String(d.department_id)] = d.name; });
    const staffName = {};
    (staffRes.data || []).forEach((s) => { staffName[String(s.employee_id)] = s.name; });

    const rows = tenderRes.data || [];

    // ---- by tender ----
    const byTender = {};
    rows.forEach((r) => {
      const id = String(r.tender_id);
      const t = typeOf[id] || {};
      if (!byTender[id]) {
        byTender[id] = {
          tender_id: id,
          name: t.description || ('Tender ' + id),
          named: !!t.description,
          bucket: t.bucket || 'other',
          sort: t.sort_order === undefined ? 99 : t.sort_order,
          amount: 0, count: 0,
        };
      }
      byTender[id].amount = money(byTender[id].amount + money(r.tender_amount));
      byTender[id].count += Number(r.tender_qty) || 0;
    });
    const tenders = Object.keys(byTender).map((k) => byTender[k]).sort((a, b) => a.sort - b.sort);

    // Coupons are not money taken in, so they never count toward the take.
    const taken = money(tenders.filter((t) => t.bucket !== 'other')
      .reduce((s, t) => s + t.amount, 0));
    const cash = money(tenders.filter((t) => t.bucket === 'cash').reduce((s, t) => s + t.amount, 0));
    const card = money(tenders.filter((t) => t.bucket === 'card').reduce((s, t) => s + t.amount, 0));
    const check = money(tenders.filter((t) => t.bucket === 'check').reduce((s, t) => s + t.amount, 0));

    // ---- by department ----
    const departments = (deptRes.data || [])
      .map((d) => ({
        department_id: String(d.department_id),
        name: deptName[String(d.department_id)] || ('Department ' + d.department_id),
        named: !!deptName[String(d.department_id)],
        sales: money(d.net_sales_amount),
        items: Number(d.net_sales_qty) || 0,
        returns: money(d.return_sales_amount),
        discounts: money(d.discount_sales_amount),
      }))
      .filter((d) => d.sales !== 0 || d.items !== 0)
      .sort((a, b) => b.sales - a.sales);

    const deptTotal = money(departments.reduce((s, d) => s + d.sales, 0));

    // ---- by cashier ----
    const byStaff = {};
    rows.forEach((r) => {
      const id = String(r.employee_id || 'ALL');
      if (!byStaff[id]) {
        byStaff[id] = {
          employee_id: id,
          name: staffName[id] || ('Register ' + id),
          named: !!staffName[id],
          taken: 0, cash: 0, pickups: 0, pickup_count: 0,
          float: 0,
          // What the drawer declared. Encore fills DeclaredAmount, but
          // across fifty days it runs 1.5 to 2.3 times the day's tender
          // with no steady relation to it, and it is filled on a day
          // where nothing has been rung at all. So it is not a close-out
          // count of this day's money, whatever it is. Until we know,
          // nothing is reported: a figure beside "cash taken" would be
          // read as an over or a short, which is the mistake that put a
          // $2,818 surplus on a debit tender.
          declared: null,
          over_short: null,
          tenders: [],
        };
      }
      const s = byStaff[id];
      const t = typeOf[String(r.tender_id)] || {};
      const amt = money(r.tender_amount);
      if (t.bucket !== 'other') s.taken = money(s.taken + amt);
      if (t.bucket === 'cash') s.cash = money(s.cash + amt);
      s.pickups = money(s.pickups + money(r.pickup_amount));
      s.pickup_count += Number(r.pickup_qty) || 0;
      s.float = money(s.float + money(r.open_float_amount));
      // Only reported when the POS gave us one. Nothing is derived here —
      // subtracting declared from counted produced a figure that looked
      // like a shortage on card tenders, where nothing is counted at all.
      if (r.over_short_amount !== null && r.over_short_amount !== undefined) {
        s.over_short = money((s.over_short || 0) + money(r.over_short_amount));
      }
      s.tenders.push({
        tender_id: String(r.tender_id),
        name: t.description || ('Tender ' + r.tender_id),
        amount: amt,
        count: Number(r.tender_qty) || 0,
      });
    });
    const staff = Object.keys(byStaff).map((k) => byStaff[k])
      .sort((a, b) => b.taken - a.taken);

    const sync = (syncRes.data || [])[0] || null;

    return json(200, {
      store_id,
      date,
      is_latest: !q.date,
      totals: {
        taken, cash, card, check,
        departments: deptTotal,
        // The register's two views of the same day should agree. When they
        // do not, something was not captured and the difference is the
        // first thing worth knowing.
        tender_vs_department: money(taken - deptTotal),
      },
      tenders,
      departments,
      staff,
      naming: {
        tenders_named: tenders.every((t) => t.named),
        departments_named: departments.length > 0 && departments.every((d) => d.named),
        staff_named: staff.length > 0 && staff.every((s) => s.named),
      },
      over_short_available: rows.some(
        (r) => r.over_short_amount !== null && r.over_short_amount !== undefined
      ),
      // What the register actually gives us today. A field the POS leaves
      // empty is not shown at all, rather than shown as zero: "Opening
      // float $0.00" is a claim that every drawer started empty, and it
      // would be believed.
      available: {
        over_short: rows.some(
          (r) => r.over_short_amount !== null && r.over_short_amount !== undefined
        ),
        declared: false,
        float: rows.some((r) => money(r.open_float_amount) !== 0),
        pickups: rows.some((r) => money(r.pickup_amount) !== 0),
        pickup_count: rows.some((r) => (Number(r.pickup_qty) || 0) !== 0),
      },
      freshness: { last_sales_day: sync ? sync.business_date : null, synced_at: sync ? sync.synced_at : null },
    });
  } catch (err) {
    return json(500, { error: err.message, where: 'day' });
  }
};
