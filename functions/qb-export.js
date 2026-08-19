// Netlify Function: qb-export
// Exports approved check run in QuickBooks-compatible format
// Route: /.netlify/functions/qb-export
// Method: POST
// Payload: { store_id, payment_ids[] }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    const { store_id, payment_ids } = JSON.parse(event.body);

    if (!store_id || !payment_ids || !Array.isArray(payment_ids)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid request' }),
      };
    }

    // Fetch payments with allocations
    const payments = await supabase
      .from('payments')
      .select(`
        payment_id,
        check_number,
        amount,
        vendor_id,
        vendors(name, account_number),
        memo,
        payment_date,
        payment_allocations(
          allocation_id,
          invoice_id,
          amount,
          invoices(invoice_number, total_amount)
        )
      `)
      .eq('store_id', store_id)
      .in('payment_id', payment_ids)
      .eq('status', 'approved');

    if (payments.error) throw payments.error;

    // QB IIF format (Import File Format)
    const iifLines = [
      '!ACCNT\tNAME\tACCNTTYPE\tDESC\tACCNUM\tEXTRA',
      '!ENDACCNT',
      '!TRNS\tTRNSID\tTRNSTYPE\tDATE\tACCNT\tAMOUNT\tDOCNUM\tMEMO\tCLASS\tTOPRINT',
      '!SPL\tSPLID\tTRNSTYPE\tAMOUNT\tACCNT\tITEM\tINVITEM\tTAXABLE\tDESC\tQNTY\tPRICE\tINVITEM\tINVDESC',
      '!ENDSPL',
      '!ENDTRNS',
    ];

    const checkRun = {
      check_count: 0,
      total_amount: 0,
      checks: [],
    };

    // Build check records
    for (const payment of payments.data) {
      if (payment.check_number) {
        checkRun.check_count += 1;
        checkRun.total_amount += payment.amount;

        const check = {
          check_number: payment.check_number,
          payee: payment.vendors?.name || 'Unknown Vendor',
          amount: payment.amount,
          date: payment.payment_date,
          memo: payment.memo,
          invoices: payment.payment_allocations || [],
        };

        checkRun.checks.push(check);

        // IIF transaction
        iifLines.push(
          `TRNS\t${payment.payment_id}\tCHECK\t${payment.payment_date}\t20\t-${payment.amount}\t${payment.check_number}\t${payment.memo || ''}`
        );

        // Split lines for each invoice
        (payment.payment_allocations || []).forEach((alloc) => {
          iifLines.push(
            `SPL\t${alloc.allocation_id}\tCHECK\t${alloc.amount}\t50\t\t\t\t${alloc.invoices?.invoice_number || 'misc'}\t1\t${alloc.amount}`
          );
        });

        iifLines.push('ENDTRNS');
      }
    }

    // CSV format alternative
    const csvLines = [
      'Check Number,Payee,Date,Amount,Memo,Invoice Number,Invoice Amount',
    ];

    checkRun.checks.forEach((check) => {
      check.invoices.forEach((inv) => {
        csvLines.push(
          `${check.check_number},"${check.payee}",${check.date},${check.amount},"${check.memo}",${inv.invoices?.invoice_number || ''},${inv.invoices?.total_amount || ''}`
        );
      });
    });

    // Mark payments as issued
    await supabase
      .from('payments')
      .update({
        status: 'issued',
        issued_at: new Date().toISOString(),
      })
      .in('payment_id', payment_ids)
      .eq('status', 'approved');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        check_run: checkRun,
        iif_format: iifLines.join('\n'),
        csv_format: csvLines.join('\n'),
        export_timestamp: new Date().toISOString(),
        instructions: [
          '1. Download the IIF file',
          '2. In QuickBooks, go to File > Utilities > Import > IIF Files',
          '3. Select the downloaded file',
          '4. Review and print checks on pre-printed stock',
          '5. Mark as printed in QuickBooks',
        ],
      }),
    };
  } catch (error) {
    console.error('QB export error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
