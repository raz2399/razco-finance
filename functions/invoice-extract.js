// Netlify Function: invoice-extract
// Reads invoice image, extracts data via Anthropic vision API
// Route: /.netlify/functions/invoice-extract
// Method: POST
// Payload: { base64_image, mime_type, store_id }

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    const { base64_image, mime_type, store_id } = JSON.parse(event.body);

    if (!base64_image || !mime_type || !store_id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields' }),
      };
    }

    // Call Anthropic vision API
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime_type,
                data: base64_image,
              },
            },
            {
              type: 'text',
              text: `Extract invoice data from this image. Return ONLY valid JSON (no markdown) with these fields:
{
  "vendor_name": "string",
  "vendor_code": "string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "amount_subtotal": number or null,
  "amount_tax": number or null,
  "amount_freight": number or null,
  "amount_total": number,
  "description": "string (line items summary)",
  "payment_terms": "string or null",
  "confidence": number between 0 and 1
}

If a field cannot be determined, use null. amount_total is REQUIRED and must be a positive number.`,
            },
          ],
        },
      ],
    });

    // Parse response
    const textContent = response.content.find((c) => c.type === 'text');
    if (!textContent) {
      throw new Error('No text response from Claude');
    }

    let extracted;
    try {
      extracted = JSON.parse(textContent.text);
    } catch (e) {
      // Try to extract JSON from response
      const match = textContent.text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Invalid JSON from vision API');
      extracted = JSON.parse(match[0]);
    }

    // Validation
    if (!extracted.amount_total || typeof extracted.amount_total !== 'number' || extracted.amount_total <= 0) {
      throw new Error('Invalid or missing total amount');
    }

    // Look up vendor
    let vendor_id = null;
    if (extracted.vendor_name) {
      const vendor = await supabase
        .from('vendors')
        .select('vendor_id')
        .eq('store_id', store_id)
        .or(`name.ilike.%${extracted.vendor_name}%,name.ilike.${extracted.vendor_name}`)
        .limit(1)
        .single();

      if (vendor.data) {
        vendor_id = vendor.data.vendor_id;
      }
    }

    // Check for duplicates
    let duplicate_of = null;
    if (extracted.invoice_number && vendor_id) {
      const existing = await supabase
        .from('invoices')
        .select('invoice_id')
        .eq('vendor_id', vendor_id)
        .eq('invoice_number', extracted.invoice_number)
        .eq('store_id', store_id)
        .neq('status', 'void')
        .limit(1)
        .single();

      if (existing.data) {
        duplicate_of = existing.data.invoice_id;
      }
    }

    // Create invoice record
    const invoice = await supabase
      .from('invoices')
      .insert({
        store_id,
        vendor_id,
        invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date,
        received_date: new Date().toISOString().split('T')[0],
        subtotal: extracted.amount_subtotal,
        tax: extracted.amount_tax || 0,
        freight: extracted.amount_freight || 0,
        total_amount: extracted.amount_total,
        status: extracted.confidence >= 0.9 && !duplicate_of ? 'extracted' : 'needs_review',
        ocr_confidence: extracted.confidence,
        extraction_json: extracted,
        duplicate_of,
      })
      .select('invoice_id, status, extraction_json, ocr_confidence, duplicate_of')
      .single();

    if (invoice.error) {
      throw new Error(`Database insert failed: ${invoice.error.message}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        invoice_id: invoice.data.invoice_id,
        status: invoice.data.status,
        confidence: invoice.data.ocr_confidence,
        duplicate_of: invoice.data.duplicate_of,
        extracted_data: invoice.data.extraction_json,
        message: duplicate_of 
          ? 'Duplicate detected and flagged for review'
          : invoice.data.status === 'extracted'
            ? 'Ready for one-tap approval'
            : 'Needs review before approval',
      }),
    };
  } catch (error) {
    console.error('Invoice extraction error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
      }),
    };
  }
};
