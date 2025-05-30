// server.js - Express server for Render.com
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

// Remove old helper functions that are no longer needed
// getLocationKey, getProductKey, areTitlesSimilar functions removed

function deduplicateForCollection(hits, maxPerLocationPhoto = 2, targetProducts = 24) {
  // Helper function to get location_photo from product
  function getLocationPhoto(product) {
    return product.meta?.location?.details?.location_photo || null;
  }
  
  // Helper function to get style_name from product
  function getStyleName(product) {
    return product.meta?.location?.details?.style_name || null;
  }
  
  // Helper function to get base product handle (removes variant suffixes)
  function getBaseHandle(product) {
    const handle = product.handle || '';
    // Remove common variant patterns
    return handle
      .split('-variant-')[0]
      .split('-v-')[0]
      .replace(/-\d+x\d+$/, '')
      .replace(/-original-painting$/, '')
      .replace(/-print$/, '')
      .replace(/-canvas$/, '')
      .replace(/-paper$/, '');
  }
  
  // Step 0: Remove variant duplicates first
  const seenBaseHandles = new Set();
  const uniqueProducts = [];
  
  hits.forEach(product => {
    const baseHandle = getBaseHandle(product);
    if (!seenBaseHandles.has(baseHandle)) {
      seenBaseHandles.add(baseHandle);
      uniqueProducts.push(product);
    }
  });
  
  // Step 1: Group unique products by location_photo
  const productsByPhoto = {};
  const productsWithoutPhoto = [];
  
  uniqueProducts.forEach(product => {
    const locationPhoto = getLocationPhoto(product);
    if (locationPhoto) {
      if (!productsByPhoto[locationPhoto]) {
        productsByPhoto[locationPhoto] = [];
      }
      productsByPhoto[locationPhoto].push(product);
    } else {
      productsWithoutPhoto.push(product);
    }
  });
  
  // Step 2: Select max 2 products per location_photo
  const selectedProducts = [];
  
  // Add products with location_photo (max 2 per photo)
  Object.values(productsByPhoto).forEach(photoProducts => {
    selectedProducts.push(...photoProducts.slice(0, maxPerLocationPhoto));
  });
  
  // Add products without location_photo
  selectedProducts.push(...productsWithoutPhoto);
  
  // Step 3: Shuffle products with same location_photo as far apart as possible
  const result = [];
  const photoGroups = {};
  
  // Group selected products by location_photo for distribution
  selectedProducts.forEach(product => {
    const locationPhoto = getLocationPhoto(product);
    const key = locationPhoto || 'no_photo';
    if (!photoGroups[key]) {
      photoGroups[key] = [];
    }
    photoGroups[key].push(product);
  });
  
  // Distribute products to maximize distance between same location_photo
  const photoKeys = Object.keys(photoGroups);
  const photoCounters = {};
  
  // Initialize counters
  photoKeys.forEach(key => {
    photoCounters[key] = 0;
  });
  
  while (result.length < targetProducts && result.length < uniqueProducts.length) {
    let addedProduct = false;
    
    // Try to add one product from each photo group in round-robin fashion
    for (const photoKey of photoKeys) {
      if (result.length >= targetProducts) break;
      
      const products = photoGroups[photoKey];
      const counter = photoCounters[photoKey];
      
      if (counter < products.length) {
        const product = products[counter];
        
        // Check style_name adjacency rule (less important)
        let canAdd = true;
        if (result.length > 0) {
          const lastProduct = result[result.length - 1];
          const lastStyleName = getStyleName(lastProduct);
          const currentStyleName = getStyleName(product);
          
          if (lastStyleName && currentStyleName && lastStyleName === currentStyleName) {
            // Try to find a different product that doesn't violate style rule
            let alternativeFound = false;
            for (const altPhotoKey of photoKeys) {
              if (altPhotoKey === photoKey) continue;
              
              const altProducts = photoGroups[altPhotoKey];
              const altCounter = photoCounters[altPhotoKey];
              
              if (altCounter < altProducts.length) {
                const altProduct = altProducts[altCounter];
                const altStyleName = getStyleName(altProduct);
                
                if (!altStyleName || altStyleName !== lastStyleName) {
                  // Use alternative product instead
                  result.push(altProduct);
                  photoCounters[altPhotoKey]++;
                  addedProduct = true;
                  break;
                }
              }
            }
            
            if (!alternativeFound) {
              // No alternative found, add current product anyway
              result.push(product);
              photoCounters[photoKey]++;
              addedProduct = true;
            }
          } else {
            // No style conflict, add product
            result.push(product);
            photoCounters[photoKey]++;
            addedProduct = true;
          }
        } else {
          // First product, add without checks
          result.push(product);
          photoCounters[photoKey]++;
          addedProduct = true;
        }
        
        break; // Move to next photo group
      }
    }
    
    if (!addedProduct) {
      // No more products available in any group
      break;
    }
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
          <p class="geo-results__count">
            Showing ${products.length} ${products.length === 1 ? 'artwork' : 'artworks'} 
            from ${escapeHtml(cityName)} and nearby areas
            ${totalHits > products.length ? ` (${totalHits - products.length} more available)` : ''}
          </p>
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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'algolia-cache-server',
    cache_size: cache.size,
    uptime: process.uptime() + 's'
  });
});

// Cache stats endpoint
app.get('/cache-stats', (req, res) => {
  const stats = {
    size: cache.size,
    keys: Array.from(cache.keys()),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  };
  res.json(stats);
});

// Your existing nearby search endpoint
app.post('/api/nearby-search', async (req, res) => {
  try {
    const { 
      lat, 
      lng, 
      radiusKm = 30, 
      hitsPerPage = 24, 
      currentHandle,
      maxPerLocationPhoto = 2,
      fallback = false
    } = req.body;

    console.log(`🌍 Nearby search:`, {
      location: lat && lng ? `${lat}, ${lng}` : 'fallback',
      radius: `${radiusKm}km`,
      page: hitsPerPage
    });

    if (!fallback && (!lat || !lng)) {
      return res.status(400).json({
        error: 'Missing required parameters: lat, lng (or set fallback: true)'
      });
    }

    // Create cache key
    const cacheKey = `nearby:${lat || 'fallback'}:${lng || 'fallback'}:${radiusKm}:${hitsPerPage}:${maxPerLocationPhoto}`;
    
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

    const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME || 'shopify_products');

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

    const searchResponse = await index.search('', searchParams);
    const uniqueHits = deduplicateForCollection(searchResponse.hits, maxPerLocationPhoto, hitsPerPage);

    const response = {
      hits: uniqueHits,
      totalHits: searchResponse.nbHits,
      cached: false,
      searchTime: searchResponse.processingTimeMS
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
      message: error.message
    });
  }
});

// Pre-generate collection endpoint
app.post('/api/pre-generate-collection', async (req, res) => {
  try {
    const { 
      lat, 
      lng, 
      radiusKm = 30, 
      cityName,
      collectionHandle,
      hitsPerPage = 24,
      forceRegenerate = false
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
      handle: collectionHandle
    });

    // Create cache key
    const cacheKey = `static-collection:${cityName}:${lat}:${lng}:${radiusKm}:${hitsPerPage}`;
    
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

    const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME || 'shopify_products');

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

    const searchResponse = await index.search('', searchParams);
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
      processingTime: `${searchResponse.processingTimeMS}ms`
    });

    res.json({
      html: staticHTML,
      cached: false,
      generated: cacheData.generated,
      stats: {
        products: deduplicatedHits.length,
        totalHits: searchResponse.nbHits,
        city: cityName,
        searchTime: searchResponse.processingTimeMS
      }
    });

  } catch (error) {
    console.error('❌ Pre-generation error:', error);
    res.status(500).json({
      error: 'Pre-generation failed',
      message: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Algolia cache server running on port ${PORT}`);
  console.log(`📊 Cache initialized - persistent storage enabled`);
});

module.exports = app;