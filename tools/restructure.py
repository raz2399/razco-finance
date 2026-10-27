"""
Rebuild the front end into six work-shaped screens.

Run from the repo root. It is written as one pass with a check after every
step, because doing this as a series of separate surgical edits is how the
last attempt lost three screens without noticing.

  python3 tools/restructure.py
"""

import io
import re
import sys
import subprocess

PATH = 'index.html'


def read():
    return io.open(PATH, encoding='utf-8').read()


def write(s):
    io.open(PATH, 'w', encoding='utf-8').write(s)


def check(step):
    """Every element the script references must still exist on the page."""
    out = subprocess.run(['node', '-e', '''
const fs=require('fs');const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
const d=new JSDOM(html,{url:'https://x.netlify.app/'}).window.document;
const ids=[...html.matchAll(/getElementById\\('([a-z0-9-]+)'\\)/g)].map(m=>m[1]);
const missing=[...new Set(ids)].filter(i=>!d.getElementById(i));
if (missing.length) { console.error('MISSING: '+missing.join(', ')); process.exit(1); }
const panels=[...d.querySelectorAll('.tab-content')].map(p=>p.id);
const tabs=[...d.querySelectorAll('.tab')].map(t=>t.getAttribute('data-tab'));
const orphan=tabs.filter(t=>!panels.includes(t+'-tab'));
if (orphan.length) { console.error('TAB WITH NO PANEL: '+orphan.join(', ')); process.exit(1); }
console.log('panels: '+panels.join(','));
'''], capture_output=True, text=True, cwd='.')
    if out.returncode != 0:
        print('  FAILED after %s\n  %s' % (step, out.stderr.strip()))
        sys.exit(1)
    print('  ok   %s — %s' % (step, out.stdout.strip()))


def panel_span(lines, tab_id):
    start = next(i for i, l in enumerate(lines) if ('id="%s-tab"' % tab_id) in l)
    depth = 0
    for j in range(start, len(lines)):
        depth += lines[j].count('<div') - lines[j].count('</div>')
        if depth == 0 and j > start:
            return start, j
    raise AssertionError('unbalanced panel: ' + tab_id)



def split_charges(html):
    """Receiving is one job; writing the checks that are due is another."""
    lines = html.split('\n')
    moved, keep, i = [], [], 0
    while i < len(lines):
        if 'Write checks for' in lines[i] or 'The bank is taking' in lines[i] \
           or 'Still to enter in QuickBooks' in lines[i]:
            start = i
            while start >= 0 and 'class="card"' not in lines[start]:
                start -= 1
            depth, end = 0, start
            for j in range(start, len(lines)):
                depth += lines[j].count('<div') - lines[j].count('</div>')
                if depth == 0 and j > start:
                    end = j
                    break
            # anything already copied into keep from this card comes back out
            taken = lines[start:end + 1]
            keep = keep[:len(keep) - (i - start)]
            moved.extend(taken)
            i = end + 1
            continue
        keep.append(lines[i])
        i += 1
    return '\n'.join(keep), '\n'.join(moved)


def strip_h2(html):
    return re.sub(r'<h2[^>]*>[^<]*</h2>\s*', '', html, count=1)


# ---------------------------------------------------------------- 1. palette
def step_palette():
    s = read()
    old = """    :root {
      --primary: #1a472a;
      --secondary: #d4af37;
      --danger: #dc3545;
      --warning: #ffc107;
      --success: #28a745;
      --info: #17a2b8;
      --bg: #f8f9fa;
      --border: #dee2e6;
      --text: #333;
      --text-light: #666;
    }"""
    new = """    :root {
      /* Razi-Tech. Every screen reads from these, so the app is one product
         rather than whichever week each screen happened to be built in. */
      --primary: #c0282d;
      --secondary: #4a7fc1;
      --danger: #c0282d;
      --warning: #bf7b0a;
      --success: #168a5a;
      --info: #29a8e0;
      --bg: #f4f6f9;
      --border: #e4e8ef;
      --text: #1a1c21;
      --text-light: #6b7280;
    }"""
    assert old in s, 'palette block not found'
    s = s.replace(old, new, 1)

    shared = r'''
    /* ---- the older screens, brought onto the same furniture ---- */
    .card{background:#fff;border:1px solid var(--border);border-radius:14px;
      padding:16px 18px;margin-bottom:12px;box-shadow:none}
    .card h2,.card h3{font-size:11px;font-weight:800;letter-spacing:.9px;
      text-transform:uppercase;color:var(--text-light);margin:0 0 11px}
    .content{background:var(--bg)}
    table th{font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;
      color:var(--text-light);border-bottom:1px solid var(--border);padding:0 0 8px}
    table td{padding:9px 0;border-bottom:1px solid #f1f3f7;font-variant-numeric:tabular-nums}
    .number{font-size:28px;font-weight:800;letter-spacing:-1px}
    .number.positive{color:var(--success)}
    .number.negative{color:var(--danger)}
    .alert{border-radius:9px;padding:11px 13px;font-size:13px;line-height:1.5;
      margin-bottom:9px;border-left:3px solid var(--text-light);background:#f7f9fc}
    .alert-critical{background:#fdf1f1;border-left-color:var(--danger);color:#8d2024}
    .alert-warning{background:#fdf8ec;border-left-color:var(--warning);color:#8a6414}
    input,select,textarea{border:1px solid var(--border)!important;border-radius:10px!important;
      padding:12px 13px!important;font-size:16px!important;background:#fff!important;
      color:var(--text)!important}
    input:focus,select:focus{outline:none;border-color:var(--secondary)!important}
    label:not(.rn-shoot){color:var(--text-light)!important}
    /* a few cards carried the old green in an inline style */
    [style*="#1a472a"]{border-left-color:var(--primary)!important}

    .rn-screenhead{margin-bottom:14px}
    .rn-screentitle{font-size:21px;font-weight:800;color:var(--rn-ink);
      letter-spacing:-.5px;margin:0}
    .rn-screensub{font-size:13px;color:var(--rn-mute);margin:3px 0 0;line-height:1.5}

    .rn-capture{border:2px dashed var(--rn-blue);border-radius:11px;padding:13px;
      margin-bottom:14px;background:#f8fbff}
    .rn-capture-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .rn-shoot{display:inline-flex;align-items:center;gap:8px;background:var(--rn-blue);
      color:#fff!important;border-radius:9px;padding:11px 16px;font-size:14px;
      font-weight:700;cursor:pointer;width:auto}
    .rn-shoot:active{background:#3d6aa5}
    .rn-shoot-icon{font-size:17px}
    .rn-capture-or{font-size:12px;color:var(--rn-mute)}
    .rn-capture-state{margin-top:10px;font-size:12.5px;line-height:1.5;border-radius:8px;padding:9px 11px}
    .rn-capture-state.working{background:#eef4fb;color:#2c5c96}
    .rn-capture-state.good{background:#eef7f2;color:#136541}
    .rn-capture-state.check{background:#fdf8ec;color:#8a6414}
    .rn-capture-state.bad{background:#fdf1f1;color:#a32226}
    .rn-thumb{margin-top:10px;max-height:120px;border-radius:8px;border:1px solid var(--rn-line)}
'''
    s = s.replace('  </style>', shared + '  </style>', 1)
    write(s)
    check('palette')


# ------------------------------------------------------------- 2. the tab bar
def step_tabs():
    s = read()
    old = """    <button class="tab active" data-tab="home">Home</button>
    <button class="tab" data-tab="sales">Sales</button>
    <button class="tab" data-tab="calendar">AP Calendar</button>
    <button class="tab" data-tab="checks">Checks</button>
    <button class="tab" data-tab="charges">Charges</button>
    <button class="tab" data-tab="cash">Cash</button>
    <button class="tab" data-tab="pl">P&L</button>
    <button class="tab" data-tab="bank">Bank</button>
    <button class="tab" data-tab="settings">Settings</button>"""
    new = """    <button class="tab active" data-tab="home">Today</button>
    <button class="tab" data-tab="receive">Receive</button>
    <button class="tab" data-tab="pay">Pay</button>
    <button class="tab" data-tab="money">Money</button>
    <button class="tab" data-tab="week">Week</button>
    <button class="tab" data-tab="settings">Settings</button>"""
    assert old in s, 'tab bar not found'
    write(s.replace(old, new, 1))
    # the panels do not exist yet, so only check once they do


# ------------------------------------------------- 3. regroup into six panels
def step_panels():
    s = read()
    lines = s.split('\n')

    pieces = {}
    for t in ['sales', 'calendar', 'checks', 'charges', 'cash', 'pl', 'bank', 'settings']:
        a, b = panel_span(lines, t)
        pieces[t] = '\n'.join(lines[a + 1:b])

    # The old Charges panel held two different jobs: receiving a delivery and
    # paying what is due. They belong on different screens.
    pieces['charges'], pay_run = split_charges(pieces['charges'])
    pieces['pay_run'] = pay_run

    old_tabs = ['sales', 'calendar', 'checks', 'charges', 'cash', 'pl', 'bank', 'settings']
    spans = sorted([panel_span(lines, t) for t in old_tabs], key=lambda x: -x[0])
    for a, b in spans:
        del lines[a:b + 1]
    s = '\n'.join(lines)

    def screen(tab_id, title, sub, body):
        return '''    <div class="tab-content" id="%s-tab">
      <div class="rn-wrap">
        <div class="rn-screenhead">
          <h2 class="rn-screentitle">%s</h2>
          <p class="rn-screensub">%s</p>
        </div>
%s
      </div>
    </div>

''' % (tab_id, title, sub, body)

    built = (
        screen('receive', 'Receive',
               'A delivery landed. Photograph the invoice and it is recorded before it reaches the desk.',
               pieces['charges'])
        + screen('pay', 'Pay',
                 'What is owed, what you write a check for, and what the bank takes on its own.',
                 strip_h2(pieces['checks']) + '\n' + pieces['pay_run'] + '\n' + strip_h2(pieces['calendar']))
        + screen('money', 'Money',
                 'What is actually in the bank and the drawer. Correct anything the system has wrong.',
                 FIX_CARD + '\n' + strip_h2(pieces['cash']) + '\n' + strip_h2(pieces['bank']) + '\n' + FIX_LOG)
        + screen('week', 'Week',
                 'Monday to Sunday night. Sales, profit, and the close.',
                 strip_h2(pieces['pl']) + '\n' + strip_h2(pieces['sales']))
        + screen('settings', 'Settings', 'How this store is set up.', pieces['settings'])
    )

    anchor = '  </div>\n</div>\n\n<script>'
    assert anchor in s, 'content close anchor not found'
    write(s.replace(anchor, built + anchor, 1))
    check('six panels')


FIX_CARD = '''        <div class="card" id="fix-card">
          <h3>Correct a figure</h3>
          <p style="font-size:12.5px;color:var(--text-light);margin:-4px 0 12px;line-height:1.5">
            Counted it and the system disagrees? Your figure wins. The change is written down with the reason.
          </p>
          <div id="fix-msg" style="display:none;border-radius:9px;padding:11px 13px;font-size:13px;margin-bottom:12px;line-height:1.5"></div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:190px">
              <label style="display:block;font-size:11px;font-weight:700;margin-bottom:5px">WHAT IS WRONG</label>
              <select id="fix-target">
                <option value="cash">Cash on hand &mdash; drawer and safe</option>
                <option value="bank">Bank balance</option>
              </select>
            </div>
            <div style="flex:1;min-width:190px">
              <label style="display:block;font-size:11px;font-weight:700;margin-bottom:5px">WHAT IT SHOULD BE</label>
              <input id="fix-amount" type="text" inputmode="decimal" placeholder="0.00">
            </div>
          </div>
          <label style="display:block;font-size:11px;font-weight:700;margin:12px 0 5px">WHY (OPTIONAL)</label>
          <input id="fix-note" type="text" placeholder="Counted the safe, we were short a deposit">
          <div id="fix-current" style="font-size:12.5px;color:var(--text-light);margin:10px 0;line-height:1.6"></div>
          <button class="rn-big" id="fix-save" style="margin-top:4px">Save the correct figure</button>
        </div>'''

FIX_LOG = '''        <div class="card">
          <h3>Corrections made</h3>
          <div id="fix-log" class="rn-rows"><p style="font-size:13px;color:var(--text-light)">Loading&hellip;</p></div>
        </div>'''


# ------------------------------------------------------------ 4. the cameras
def step_cameras():
    s = read()

    def cam(el_id, label, aside):
        return '''        <div class="rn-capture">
          <div class="rn-capture-row">
            <label class="rn-shoot" for="%s"><span class="rn-shoot-icon">&#128247;</span><span>%s</span></label>
            <input id="%s" type="file" accept="image/*" capture="environment" style="display:none">
            <span class="rn-capture-or">%s</span>
          </div>
          <div id="%s-state" class="rn-capture-state" style="display:none"></div>
        </div>

''' % (el_id, label, el_id, aside, el_id)

    targets = [
        ('inv-photo', 'Photograph the invoice', 'or fill it in below',
         '<label style="display:block;font-size:11px;color:#666;font-weight:700;margin-bottom:5px">VENDOR</label>'),
        ('chk-photo', 'Photograph the check or stub', 'or fill it in below',
         '<h3 style="margin:0 0 14px;font-size:15px">Log a check</h3>'),
        ('stmt-photo', 'Photograph a statement page', 'or import the CSV below &mdash; better for a whole month',
         '<label style="display:block;font-size:11px;color:#666;font-weight:700;margin-bottom:5px">ENDING BALANCE ON THE STATEMENT</label>'),
    ]
    for el_id, label, aside, anchor in targets:
        if ('id="%s"' % el_id) in s:
            continue  # already on the page from an earlier build
        assert anchor in s, 'anchor missing for ' + el_id
        if el_id == 'chk-photo':
            s = s.replace(anchor, anchor + '\n' + cam(el_id, label, aside), 1)
        else:
            s = s.replace(anchor, cam(el_id, label, aside) + '        ' + anchor, 1)
    write(s)
    check('cameras')


# --------------------------------------------------------------- 5. routing
def step_routing():
    s = read()
    old = """    if (tabName === 'sales') this.loadSales();
    if (tabName === 'calendar') this.loadAPCalendar();
    if (tabName === 'cash') this.loadCashPosition();
    if (tabName === 'pl') this.loadPL();
    if (tabName === 'checks') this.loadChecks();
    if (tabName === 'charges') this.loadInvoices();"""
    new = """    // Each screen is several of the old ones, so each loads all its parts.
    if (tabName === 'home') this.loadHome();
    if (tabName === 'receive') this.loadInvoices();
    if (tabName === 'pay') { this.loadChecks(); this.loadAPCalendar(); this.loadInvoices(); }
    if (tabName === 'money') { this.loadCashPosition(); this.loadCorrections(); }
    if (tabName === 'week') { this.loadPL(); this.loadSales(); this.loadClose(); }"""
    assert old in s, 'routing block not found'
    write(s.replace(old, new, 1))
    check('routing')


if __name__ == '__main__':
    print('Rebuilding the front end into six screens')
    step_palette()
    step_tabs()
    step_panels()
    step_cameras()
    step_routing()
    print('Done.')
