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
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly'
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

  if (!code) {
    return res.send('No authorization code received from eBay.');
  }

  const basicAuth = Buffer.from(
    process.env.EBAY_CLIENT_ID + ':' + process.env.EBAY_CLIENT_SECRET
  ).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
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

app.post('/create-ebay-draft', async (req, res) => {
  const token = requireToken(res);
  if (!token) return;

  const listing = req.body;

  const required = [
    'sku',
    'title',
    'description',
    'price',
    'quantity',
    'condition',
    'categoryId',
    'inventoryLocationKey',
    'paymentPolicyId',
    'returnPolicyId',
    'fulfillmentPolicyId'
  ];

  const missing = required.filter((field) => !listing[field]);

  if (missing.length) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields before eBay draft can be created.',
      missing
    });
  }

  const sku = String(listing.sku).trim();

  const inventoryBody = {
    product: {
      title: listing.title,
      description: listing.description,
      aspects: listing.aspects || {},
      imageUrls: listing.imageUrls || []
    },
    condition: listing.condition,
    availability: {
      shipToLocationAvailability: {
        quantity: Number(listing.quantity)
      }
    }
  };

  const inventoryResult = await ebayRequest(
    `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    {
      method: 'PUT',
      body: JSON.stringify(inventoryBody)
    }
  );

  if (!inventoryResult.ok && inventoryResult.status !== 204) {
    return res.status(400).json({
      success: false,
      step: 'inventory_item',
      ebayResponse: inventoryResult.data
    });
  }

  const offerBody = {
    sku,
    marketplaceId: MARKETPLACE_ID,
    format: 'FIXED_PRICE',
    availableQuantity: Number(listing.quantity),
    categoryId: listing.categoryId,
    merchantLocationKey: listing.inventoryLocationKey,
    listingDescription: listing.description,
    pricingSummary: {
      price: {
        value: String(listing.price),
        currency: 'USD'
      }
    },
    listingPolicies: {
      paymentPolicyId: listing.paymentPolicyId,
      returnPolicyId: listing.returnPolicyId,
      fulfillmentPolicyId: listing.fulfillmentPolicyId
    }
  };

  const offerResult = await ebayRequest(
    'https://api.ebay.com/sell/inventory/v1/offer',
    {
      method: 'POST',
      body: JSON.stringify(offerBody)
    }
  );

  if (!offerResult.ok) {
    return res.status(400).json({
      success: false,
      step: 'offer',
      ebayResponse: offerResult.data
    });
  }

  res.json({
    success: true,
    message: 'eBay draft/unpublished offer created. It has NOT been published live.',
    offer: offerResult.data
  });
});

// -------------------- Server --------------------

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});