"""
Razi-Nova finance sync.

Reads sales out of the Encore POS database on this PC and sends them to the
Razi-Nova finance app.

It does NOT touch encore_sync.py, run_sync.bat, or anything the back office
uses. It only READS from Encore. It holds no database password: it posts to
the finance site, which holds the credentials.

Run it:
    python finance_sync.py              -> yesterday and today
    python finance_sync.py 7            -> the last 7 days
    python finance_sync.py 2026-09-08 2026-10-26   -> that range

Everything it sends replaces what is already stored for those days, so
running it twice can never double a number.
"""

import sys
import json
import datetime
import urllib.request
import urllib.error

try:
    import pyodbc
except ImportError:
    sys.exit("pyodbc is not installed on this PC. The Encore sync needs it.")

# ---------------------------------------------------------------- settings
SQL_SERVER = "localhost"
SQL_DATABASE = "ENCOR"
STORE_ID = "store1"
STORE_NAME = "Razco Foods"

ENDPOINT = "https://famous-caramel-1cf571.netlify.app/.netlify/functions/ingest"
TOKEN = "RAZINOVA-STORE1-2024"

# Days per POST. Keeps each request small enough to finish comfortably.
BATCH_DAYS = 7


def log(msg):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print("[%s] %s" % (stamp, msg))
    sys.stdout.flush()


# ------------------------------------------------------------- connection
def connect():
    """Open Encore with whichever SQL Server driver this PC actually has."""
    available = [d for d in pyodbc.drivers() if "SQL Server" in d]
    if not available:
        sys.exit("No SQL Server ODBC driver found on this PC.")

    # Newest first.
    preferred = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "ODBC Driver 13 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server",
    ]
    ordered = [d for d in preferred if d in available] + \
              [d for d in available if d not in preferred]

    last = None
    for driver in ordered:
        conn_str = (
            "DRIVER={%s};SERVER=%s;DATABASE=%s;Trusted_Connection=yes;"
            % (driver, SQL_SERVER, SQL_DATABASE)
        )
        if "18" in driver:
            conn_str += "TrustServerCertificate=yes;"
        try:
            cn = pyodbc.connect(conn_str, timeout=10)
            log("Connected to %s using %s" % (SQL_DATABASE, driver))
            return cn
        except Exception as e:
            last = e
    sys.exit("Could not open %s. Last error: %s" % (SQL_DATABASE, last))


def columns_of(cur, table):
    """Column names of a table, or an empty list if it does not exist."""
    cur.execute(
        "SELECT name FROM sys.columns WHERE object_id = OBJECT_ID(?) ORDER BY column_id",
        "dbo." + table,
    )
    return [r[0] for r in cur.fetchall()]


def pick(available, *candidates):
    """First candidate column that really exists, matched case-insensitively."""
    lower = {c.lower(): c for c in available}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


# ------------------------------------------------------------------ reads
def read_tenders(cur, date_str, plan):
    """One row per tender, per cashier when the POS records it that way."""
    table, cols = plan["table"], plan["cols"]
    emp = plan["employee"]

    select = [cols["tender_id"] + " AS tender_id"]
    select.append((emp or "NULL") + " AS employee_id")
    for key in ("open_float_amount", "tender_amount", "tender_qty",
                "pickup_amount", "pickup_qty", "declared_amount"):
        col = cols.get(key)
        select.append(("ISNULL(%s,0)" % col if col else "0") + " AS " + key)

    sql = "SELECT %s FROM ENCOR.dbo.%s WHERE %s = ?" % (
        ", ".join(select), table, cols["business_date"])

    cur.execute(sql, date_str)
    names = [d[0] for d in cur.description]
    rows = []
    for r in cur.fetchall():
        row = dict(zip(names, r))
        # Over/short is worked out by the finance site, so the rule lives in
        # one place rather than depending on which machine sent the data.
        rows.append({k: (float(v) if isinstance(v, (int, float)) or
                         hasattr(v, "quantize") else v)
                     for k, v in row.items()})
    return rows


def read_departments(cur, date_str, plan):
    table, cols = plan["table"], plan["cols"]
    select = [cols["department_id"] + " AS department_id"]
    for key in ("net_sales_amount", "net_sales_qty",
                "return_sales_amount", "discount_sales_amount"):
        col = cols.get(key)
        select.append(("ISNULL(%s,0)" % col if col else "0") + " AS " + key)

    sql = ("SELECT %s FROM ENCOR.dbo.%s WHERE %s = ?"
           % (", ".join(select), table, cols["business_date"]))

    cur.execute(sql, date_str)
    names = [d[0] for d in cur.description]
    out = []
    for r in cur.fetchall():
        row = dict(zip(names, r))
        out.append({k: (float(v) if hasattr(v, "quantize") else v)
                    for k, v in row.items()})
    return out


# ------------------------------------------------------------------ plans
def build_plans(cur):
    """Work out which Encore tables and columns this POS actually has."""
    plans = {}

    # Tenders, per cashier if that table exists, otherwise store level.
    for table in ("TenderByEmployeeDay", "TenderByDay"):
        cols = columns_of(cur, table)
        if not cols:
            continue
        bd = pick(cols, "BusinessDate")
        tid = pick(cols, "TenderId")
        amt = pick(cols, "TenderAmount")
        if not (bd and tid and amt):
            continue
        plans["tender"] = {
            "table": table,
            "employee": pick(cols, "EmployeeId", "CashierId", "OperatorId"),
            "cols": {
                "business_date": bd,
                "tender_id": tid,
                "tender_amount": amt,
                "open_float_amount": pick(cols, "OpenFloatAmount"),
                "tender_qty": pick(cols, "TenderQty"),
                "pickup_amount": pick(cols, "PickupAmount"),
                "pickup_qty": pick(cols, "PickupQty"),
                "declared_amount": pick(cols, "DeclaredAmount"),
            },
        }
        break
    if "tender" not in plans:
        sys.exit("No usable tender table found in Encore.")

    cols = columns_of(cur, "DepartmentSalesByDay")
    if cols:
        plans["dept"] = {
            "table": "DepartmentSalesByDay",
            "cols": {
                "business_date": pick(cols, "BusinessDate"),
                "department_id": pick(cols, "DepartmentId"),
                "net_sales_amount": pick(cols, "NetSalesAmount"),
                "net_sales_qty": pick(cols, "NetSalesQty", "CustomerQty"),
                "return_sales_amount": pick(cols, "ReturnSalesAmount", "ReturnAmount"),
                "discount_sales_amount": pick(cols, "DiscountSalesAmount", "DiscountAmount"),
            },
        }

    log("Tenders from %s%s" % (
        plans["tender"]["table"],
        " (by cashier)" if plans["tender"]["employee"] else " (store level)"))
    if "dept" in plans:
        log("Departments from DepartmentSalesByDay")
    return plans


# ------------------------------------------------------------------- send
def send(days):
    payload = json.dumps({
        "token": TOKEN,
        "store_id": STORE_ID,
        "store_name": STORE_NAME,
        "days": days,
    }).encode("utf-8")

    req = urllib.request.Request(
        ENDPOINT, data=payload,
        headers={"Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError("Finance site said %s: %s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError("Could not reach the finance site: %s" % e.reason)


# ------------------------------------------------------------------- main
def date_list():
    args = sys.argv[1:]
    today = datetime.date.today()

    if len(args) == 2:
        a = datetime.date.fromisoformat(args[0])
        b = datetime.date.fromisoformat(args[1])
        if b < a:
            a, b = b, a
        return [a + datetime.timedelta(days=i) for i in range((b - a).days + 1)]

    if len(args) == 1 and args[0].isdigit():
        n = int(args[0])
        return [today - datetime.timedelta(days=i) for i in range(n - 1, -1, -1)]

    if len(args) == 1:
        d = datetime.date.fromisoformat(args[0])
        return [d]

    return [today - datetime.timedelta(days=1), today]


def main():
    log("=== Razi-Nova finance sync ===")
    dates = date_list()
    log("%d day(s): %s to %s" % (len(dates), dates[0], dates[-1]))

    cn = connect()
    cur = cn.cursor()
    plans = build_plans(cur)

    collected = []
    for d in dates:
        ds = d.isoformat()
        tenders = read_tenders(cur, ds, plans["tender"])
        depts = read_departments(cur, ds, plans["dept"]) if "dept" in plans else []
        money = sum(float(t.get("tender_amount") or 0) for t in tenders)
        if tenders or depts:
            log("%s  tenders %-4d departments %-4d  $%s"
                % (ds, len(tenders), len(depts), format(round(money, 2), ",.2f")))
        else:
            log("%s  nothing recorded" % ds)
        collected.append({
            "business_date": ds,
            "tenders": tenders,
            "departments": depts,
        })
    cn.close()

    sent = 0
    for i in range(0, len(collected), BATCH_DAYS):
        chunk = collected[i:i + BATCH_DAYS]
        res = send(chunk)
        if not res.get("ok"):
            sys.exit("Rejected: %s" % res.get("error"))
        sent += res.get("days_written", 0)
        log("sent %s to %s" % (chunk[0]["business_date"], chunk[-1]["business_date"]))

    grand = sum(float(t.get("tender_amount") or 0)
                for day in collected for t in day["tenders"])
    log("Done. %d day(s) stored, $%s in tenders."
        % (sent, format(round(grand, 2), ",.2f")))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        log("FAILED: %s" % exc)
        sys.exit(1)
