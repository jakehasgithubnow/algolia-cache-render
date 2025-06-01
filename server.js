// server.js - Express server for Render.com with German locale support
const express = require('express');
const cors = require('cors');
const algoliasearch = require('algoliasearch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory cache that persists (unlike Vercel serverless)
const cache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Multiple index support for different locales
const ALGOLIA_INDEXES = {
  'en': 'shopify_products',
  'de': 'shopify_produkte',
  'default': 'shopify_products'
};

// Import your existing deduplication functions
function getLocationKey(product) {
  const meta = product.meta || {};
  const locationMeta = meta.location || {};
  const details = locationMeta.details || {};
  
  if (details.latitude && details.longitude) {
    return `${details.latitude.toFixed(6)},${details.longitude.toFixed(6)}`;
  }
  
  if (details.google_id) {
    return `google_id:${details.google_id}`;
  }
  
  if (details.formatted_address) {
    return `address:${details.formatted_address}`;
  }
  
  return `unique:${product.handle}`;
}

function getProductKey(product) {
  const handle = product.handle || '';
  let baseHandle = handle.split('-variant-')[0].split('-v-')[0];
  baseHandle = baseHandle.replace(/-\d+x\d+/, '').replace(/-original-painting/, '').replace(/-print/, '');
  return baseHandle;
}

function areTitlesSimilar(title1, title2, threshold = 0.8) {
  if (!title1 || !title2) return false;
  
  const t1 = title1.toLowerCase().trim();
  const t2 = title2.toLowerCase().trim();
  
  if (t1 === t2) return true;
  
  const words1 = t1.split(/\s+/);
  const words2 = t2.split(/\s+/);
  let commonWords = 0;
  
  words1.forEach(word => {
    if (word.length > 2 && words2.includes(word)) {
      commonWords++;
    }
  });
  
  const similarity = (commonWords * 2) / (words1.length + words2.length);
  return similarity >= threshold;
}

function deduplicateForCollection(hits, maxPerLocation = 2, targetProducts = 24) {
  // Step 1: Remove product duplicates
  const seenProducts = {};
  const uniqueProducts = [];
  
  hits.forEach(product => {
    const productKey = getProductKey(product);
    const title = product.title || '';
    
    if (seenProducts[productKey]) {
      return;
    }
    
    const isSimilarToExisting = uniqueProducts.some(existingProduct => 
      areTitlesSimilar(title, existingProduct.title, 0.8)
    );
    
    if (isSimilarToExisting) {
      return;
    }
    
    seenProducts[productKey] = true;
    uniqueProducts.push(product);
  });
  
  // Step 2: Apply location-based distribution  
  const locationCounts = {};
  const result = [];
  const productsByLocation = {};
  
  uniqueProducts.forEach(product => {
    const locationKey = getLocationKey(product);
    if (!productsByLocation[locationKey]) {
      productsByLocation[locationKey] = [];
    }
    productsByLocation[locationKey].push(product);
  });
  
  let locationKeys = Object.keys(productsByLocation);
  let locationIndex = 0;
  const maxIterations = uniqueProducts.length * 2;
  let iterations = 0;
  
  while (result.length < targetProducts && iterations < maxIterations && locationKeys.length > 0) {
    iterations++;
    let foundProduct = false;
    
    for (let i = 0; i < locationKeys.length && result.length < targetProducts; i++) {
      const currentLocationIndex = (locationIndex + i) % locationKeys.length;
      const locationKey = locationKeys[currentLocationIndex];
      const productsAtLocation = productsByLocation[locationKey];
      
      if (!productsAtLocation || productsAtLocation.length === 0) {
        continue;
      }
      
      const currentCount = locationCounts[locationKey] || 0;
      if (currentCount >= maxPerLocation) {
        continue;
      }
      
      let canPlace = true;
      if (result.length > 0) {
        const lastProduct = result[result.length - 1];
        const lastLocationKey = getLocationKey(lastProduct);
        if (lastLocationKey === locationKey) {
          canPlace = false;
        }
      }
      
      if (canPlace) {
        const product = productsAtLocation.shift();
        result.push(product);
        locationCounts[locationKey] = currentCount + 1;
        foundProduct = true;
        
        if (productsAtLocation.length === 0) {
          delete productsByLocation[locationKey];
          locationKeys = Object.keys(productsByLocation);
        }
        
        break;
      }
    }
    
    if (!foundProduct) {
      break;
    }
    
    locationIndex = (locationIndex + 1) % Math.max(1, locationKeys.length);
  }
  
  return result;
}

// Generate static HTML for a collection
function generateCollectionHTML(products, collectionData) {
  const { cityName, totalHits, lat, lng, radiusKm } = collectionData;
  
  const formatPrice = (price) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR'
    }).format(price);
  };

  const escapeHtml = (text) => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Generate product grid HTML
  const productsHTML = products.map(product => {
    const imageUrl = product.product_image || product.image || '';
    const price = product.price ? formatPrice(product.price) : '';

    return `
      <div class="masonry-item">
        <div class="card-wrapper product-card-wrapper">
          <div class="card card--standard card--media">
            <a href="/products/${product.handle}" class="full-unstyled-link">
              ${imageUrl ? `
                <div class="card__media">
                  <img 
                    src="${imageUrl}" 
                    alt="${escapeHtml(product.title)}" 
                    loading="lazy" 
                    style="width: 100%; height: auto; max-height: 400px; object-fit: cover; display: block;"
                  >
                </div>
              ` : ''}
              <div class="card__content">
                <h3 class="card__heading">${escapeHtml(product.title)}</h3>
                ${price ? `<div class="price">${price}</div>` : ''}
              </div>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Complete HTML structure
  return `
    <div class="geo-results-static" data-generated="${new Date().toISOString()}" data-city="${escapeHtml(cityName)}">
      <div class="geo-results__inner">
        <div class="geo-results__meta">
        </div>
        <div class="geo-results__grid">
          <div class="masonry-grid masonry-grid--static">
            ${productsHTML}
          </div>
        </div>
      </div>
    </div>

    <script>
      // Apply masonry layout to static content
      document.addEventListener('DOMContentLoaded', function() {
        const grid = document.querySelector('.masonry-grid--static');
        if (!grid) return;
        
        const items = Array.from(grid.querySelectorAll('.masonry-item'));
        const columnCount = window.innerWidth >= 750 ? 3 : 2;
        
        function layoutStaticMasonry() {
          const containerWidth = grid.offsetWidth;
          const columnWidth = (containerWidth - (columnCount - 1) * 30) / columnCount;
          const columns = new Array(columnCount).fill(0);
          
          items.forEach((item, index) => {
            const shortestColumn = columns.indexOf(Math.min(...columns));
            
            item.style.position = 'absolute';
            item.style.left = (shortestColumn * (columnWidth + 30)) + 'px';
            item.style.top = columns[shortestColumn] + 'px';
            item.style.width = columnWidth + 'px';
            
            columns[shortestColumn] += item.offsetHeight + 30;
          });
          
          grid.style.height = Math.max(...columns) + 'px';
          grid.style.position = 'relative';
        }
        
        Promise.all(
          Array.from(grid.querySelectorAll('img')).map(img => {
            return new Promise(resolve => {
              if (img.complete) resolve();
              else {
                img.onload = resolve;
                img.onerror = resolve;
              }
            });
          })
        ).then(() => {
          layoutStaticMasonry();
        });
        
        let resizeTimeout;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimeout);
          resizeTimeout = setTimeout(layoutStaticMasonry, 250);
        });
      });
    </script>
  `;
}

// Helper function to get the correct index name
function getIndexName(locale) {
  const normalizedLocale = (locale || 'en').toLowerCase();
  return ALGOLIA_INDEXES[normalizedLocale] || ALGOLIA_INDEXES.default;
}

// Helper function to try multiple indexes
async function searchWithFallback(client, searchParams, locale) {
  const primaryIndexName = getIndexName(locale);
  const fallbackIndexName = ALGOLIA_INDEXES.default;
  
  console.log(`🔍 Trying primary index: ${primaryIndexName}`);
  
  try {
    const primaryIndex = client.initIndex(primaryIndexName);
    const response = await primaryIndex.search('', searchParams);
    console.log(`✅ Primary index "${primaryIndexName}" worked`);
    return response;
  } catch (primaryError) {
    console.log(`⚠️ Primary index "${primaryIndexName}" failed:`, primaryError.message);
    
    if (primaryIndexName !== fallbackIndexName) {
      console.log(`🔄 Trying fallback index: ${fallbackIndexName}`);
      try {
        const fallbackIndex = client.initIndex(fallbackIndexName);
        const response = await fallbackIndex.search('', searchParams);
        console.log(`✅ Fallback index "${fallbackIndexName}" worked`);
        return response;
      } catch (fallbackError) {
        console.log(`❌ Fallback index "${fallbackIndexName}" also failed:`, fallbackError.message);
        throw fallbackError;
      }
    } else {
      throw primaryError;
    }
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'algolia-cache-server',
    cache_size: cache.size,
    uptime: process.uptime() + 's',
    supported_indexes: ALGOLIA_INDEXES
  });
});

// Cache stats endpoint
app.get('/cache-stats', (req, res) => {
  const stats = {
    size: cache.size,
    keys: Array.from(cache.keys()),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    indexes: ALGOLIA_INDEXES
  };
  res.json(stats);
});

// Your existing nearby search endpoint with multi-index support
app.post('/api/nearby-search', async (req, res) => {
  try {
    const { 
      lat, 
      lng, 
      radiusKm = 30, 
      hitsPerPage = 24, 
      currentHandle,
      maxPerLocation = 2,
      fallback = false,
      locale = 'en'
    } = req.body;

    console.log(`🌍 Nearby search:`, {
      location: lat && lng ? `${lat}, ${lng}` : 'fallback',
      radius: `${radiusKm}km`,
      page: hitsPerPage,
      locale: locale,
      index: getIndexName(locale)
    });

    if (!fallback && (!lat || !lng)) {
      return res.status(400).json({
        error: 'Missing required parameters: lat, lng (or set fallback: true)',
        received: { lat, lng, fallback }
      });
    }

    // Validate coordinates
    if (!fallback && (isNaN(lat) || isNaN(lng))) {
      return res.status(400).json({
        error: 'Invalid coordinates: lat and lng must be valid numbers',
        received: { lat, lng }
      });
    }

    // Create cache key
    const cacheKey = `nearby:${lat || 'fallback'}:${lng || 'fallback'}:${radiusKm}:${hitsPerPage}:${maxPerLocation}:${locale}`;
    
    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / (1000 * 60));
      console.log(`✅ Cache HIT - Age: ${cacheAge} minutes`);
      
      return res.json({
        ...cached.data,
        cached: true,
        cacheAge: cacheAge + 'm'
      });
    }

    console.log(`⚡ Cache MISS - Searching Algolia`);

    const client = algoliasearch(
      process.env.ALGOLIA_APP_ID || '9DAT2FR7L3',
      process.env.ALGOLIA_SEARCH_API_KEY || '2daede0d3abc6d559d4fbd37d763d544'
    );

    const searchParams = {
      hitsPerPage: hitsPerPage * 3,
      attributesToRetrieve: [
        'title', 'handle', 'product_image', 'image', 'price', 
        'vendor', '_geoloc', 'meta.location.details'
      ],
      getRankingInfo: true,
      filters: currentHandle ? `NOT handle:${currentHandle}` : undefined
    };

    if (!fallback && lat && lng) {
      searchParams.aroundLatLng = `${lat},${lng}`;
      searchParams.aroundRadius = radiusKm * 1000;
    }

    const searchResponse = await searchWithFallback(client, searchParams, locale);
    const uniqueHits = deduplicateForCollection(searchResponse.hits, maxPerLocation, hitsPerPage);

    const response = {
      hits: uniqueHits,
      totalHits: searchResponse.nbHits,
      cached: false,
      searchTime: searchResponse.processingTimeMS,
      indexUsed: getIndexName(locale)
    };

    // Cache the result
    cache.set(cacheKey, {
      data: response,
      timestamp: Date.now()
    });

    // Cache cleanup
    if (cache.size > 1000) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Nearby search error:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message,
      indexAttempted: getIndexName(req.body.locale || 'en')
    });
  }
});

// Pre-generate collection endpoint with multi-index support
app.post('/api/pre-generate-collection', async (req, res) => {
  try {
    const { 
      lat, 
      lng, 
      radiusKm = 30, 
      cityName,
      collectionHandle,
      hitsPerPage = 24,
      forceRegenerate = false,
      locale = 'en'
    } = req.body;

    if (!lat || !lng || !cityName) {
      return res.status(400).json({
        error: 'Missing required parameters: lat, lng, cityName'
      });
    }

    console.log(`🏗️ Pre-generating collection:`, {
      city: cityName,
      location: `${lat}, ${lng}`,
      radius: `${radiusKm}km`,
      handle: collectionHandle,
      locale: locale,
      index: getIndexName(locale)
    });

    // Create cache key
    const cacheKey = `static-collection:${cityName}:${lat}:${lng}:${radiusKm}:${hitsPerPage}:${locale}`;
    
    // Check cache unless force regenerate
    if (!forceRegenerate) {
      const cached = cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        const cacheAge = Math.round((Date.now() - cached.timestamp) / (1000 * 60 * 60));
        console.log(`✅ Returning cached static HTML - Age: ${cacheAge} hours`);
        
        return res.json({
          html: cached.data,
          cached: true,
          cacheAge: cacheAge + 'h',
          generated: cached.generated
        });
      }
    }

    console.log(`🔍 Generating new static HTML for ${cityName}`);

    const client = algoliasearch(
      process.env.ALGOLIA_APP_ID || '9DAT2FR7L3',
      process.env.ALGOLIA_SEARCH_API_KEY || '2daede0d3abc6d559d4fbd37d763d544'
    );

    const searchParams = {
      aroundLatLng: `${lat},${lng}`,
      aroundRadius: radiusKm * 1000,
      hitsPerPage: 100,
      attributesToRetrieve: [
        'title', 'handle', 'product_image', 'image', 'price', 
        'vendor', '_geoloc', 'meta.location.details'
      ],
      getRankingInfo: true
    };

    const searchResponse = await searchWithFallback(client, searchParams, locale);
    const deduplicatedHits = deduplicateForCollection(searchResponse.hits, 2, hitsPerPage);

    const collectionData = { cityName, totalHits: searchResponse.nbHits, lat, lng, radiusKm };
    const staticHTML = generateCollectionHTML(deduplicatedHits, collectionData);

    // Cache the result
    const cacheData = {
      data: staticHTML,
      timestamp: Date.now(),
      generated: new Date().toISOString(),
      products: deduplicatedHits.length,
      totalHits: searchResponse.nbHits
    };

    cache.set(cacheKey, cacheData);

    console.log(`✅ Static HTML generated for ${cityName}:`, {
      products: deduplicatedHits.length,
      htmlSize: `${Math.round(staticHTML.length / 1024)}KB`,
      processingTime: `${searchResponse.processingTimeMS}ms`,
      indexUsed: getIndexName(locale)
    });

    res.json({
      html: staticHTML,
      cached: false,
      generated: cacheData.generated,
      stats: {
        products: deduplicatedHits.length,
        totalHits: searchResponse.nbHits,
        city: cityName,
        searchTime: searchResponse.processingTimeMS,
        indexUsed: getIndexName(locale)
      }
    });

  } catch (error) {
    console.error('❌ Pre-generation error:', error);
    res.status(500).json({
      error: 'Pre-generation failed',
      message: error.message,
      indexAttempted: getIndexName(req.body.locale || 'en')
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Algolia cache server running on port ${PORT}`);
  console.log(`📊 Cache initialized - persistent storage enabled`);
  console.log(`🌍 Supported indexes:`, ALGOLIA_INDEXES);
});

module.exports = app;