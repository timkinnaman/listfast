require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TEMPLATE_FILE = 'templates.json';
const TOKEN_FILE = 'ebay-token.json';
const MARKETPLACE_ID = 'EBAY_US';

// -------------------- Helpers --------------------

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getTokenData() {
  return readJson(TOKEN_FILE, null);
}

function saveTokenData(data) {
  writeJson(TOKEN_FILE, data);
}

function requireToken(res) {
  const tokenData = getTokenData();

  if (!tokenData || !tokenData.access_token) {
    res.status(401).json({
      connected: false,
      error: 'No eBay token saved. Connect eBay first.'
    });
    return null;
  }

  return tokenData.access_token;
}

async function ebayRequest(url, options = {}) {
  const tokenData = getTokenData();

  if (!tokenData || !tokenData.access_token) {
    return {
      ok: false,
      status: 401,
      data: { error: 'No eBay token saved. Connect eBay first.' }
    };
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + tokenData.access_token,
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      ...(options.headers || {})
    }
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

// -------------------- Templates --------------------

app.get('/templates', (req, res) => {
  res.json(readJson(TEMPLATE_FILE, {}));
});

app.post('/templates', (req, res) => {
  writeJson(TEMPLATE_FILE, req.body);
  res.json({ status: 'saved' });
});

// -------------------- eBay OAuth --------------------

app.get('/login-ebay', (req, res) => {
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  ].join(' ');

  const state = crypto.randomBytes(16).toString('hex');

  const url =
    'https://auth.ebay.com/oauth2/authorize' +
    '?client_id=' + encodeURIComponent(process.env.EBAY_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(process.env.EBAY_RUNAME) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(scopes) +
    '&state=' + encodeURIComponent(state);

  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
console.log(req.query);

  if (!code) {
    return res.send('No authorization code received from eBay.');
  }

  const basicAuth = Buffer.from(
    process.env.EBAY_CLIENT_ID + ':' + process.env.EBAY_CLIENT_SECRET
  ).toString('base64');

  const response = await fetch('https://api.ebay.com/sell/listing/v1_beta/item_draft', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_RUNAME
    })
  });

  const data = await response.json();

  if (!data.access_token) {
    return res.status(400).json({
      success: false,
      message: 'eBay did not return an access token.',
      ebayResponse: data
    });
  }

  saveTokenData(data);

  res.send('eBay connected successfully. You can close this tab.');
});

app.get('/ebay-status', async (req, res) => {
  const token = requireToken(res);
  if (!token) return;

  const result = await ebayRequest('https://api.ebay.com/sell/account/v1/privilege');

  if (!result.ok) {
    return res.json({
      connected: false,
      ebayResponse: result.data
    });
  }

  res.json({
    connected: true,
    ebayResponse: result.data
  });
});

app.post('/disconnect-ebay', (req, res) => {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  res.json({ connected: false, message: 'eBay disconnected.' });
});

// -------------------- Seller Settings --------------------

app.get('/ebay-settings', async (req, res) => {
  const token = requireToken(res);
  if (!token) return;

  const urls = {
    paymentPolicies:
      `https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`,
    returnPolicies:
      `https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}`,
    fulfillmentPolicies:
      `https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`,
    locations:
      'https://api.ebay.com/sell/inventory/v1/location'
  };

  const results = {};

  for (const [key, url] of Object.entries(urls)) {
    const result = await ebayRequest(url);
    results[key] = result.data;
  }

  res.json(results);
});

// -------------------- Create Unpublished eBay Draft --------------------
// This creates inventory + an unpublished offer.
// It does NOT publish the listing live.

// ---------------- Create Real eBay Seller Hub Draft ----------------

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function makeDraftCsv(listing) {
  const headers = [
    'Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)',
    'Custom label (SKU)',
    'Category ID',
    'Title',
    'Description',
    'Condition ID',
    'Format',
    'Start price',
    'Quantity',
    'Item photo URL'
  ];

  const row = [
    'Draft',
    listing.sku || '',
    listing.categoryId || '262388',
    listing.title || '',
    listing.description || '',
    listing.conditionId || '',
    listing.format || '',
    listing.price || '',
    listing.quantity || '',
    Array.isArray(listing.imageUrls) ? listing.imageUrls[0] || '' : ''
  ];

  return `${headers.map(csvCell).join(',')}\n${row.map(csvCell).join(',')}\n`;
}

// ---------------- Create Real eBay Draft ----------------

app.post('/create-ebay-draft', async (req, res) => {
  const token = requireToken(res);
  if (!token) return;

  const listing = req.body || {};

  const body = {
    categoryId: listing.categoryId || '262388',
    condition: listing.condition || 'USED_GOOD',
    format: listing.format || 'FIXED_PRICE',
    pricingSummary: {
      price: {
        currency: 'USD',
        value: listing.price || '0.99'
      }
    },
    product: {
      title: listing.title || 'Untitled Draft',
      description: listing.description || '',
      imageUrls: Array.isArray(listing.imageUrls) ? listing.imageUrls : []
    }
  };

  try {
    const response = await fetch('https://api.ebay.com/sell/listing/v1_beta/item_draft/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        step: 'create_item_draft',
        status: response.status,
        response: text,
        sent: body
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return res.json({
      success: true,
      message: 'eBay draft created.',
      draft: data
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      step: 'server_error',
      error: error.message
    });
  }
});

// -------------------- Server --------------------

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});