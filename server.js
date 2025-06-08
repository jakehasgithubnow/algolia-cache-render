// server.js - Express server for Render.com with SSR Pre-rendering
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

// Original deduplication function (keep for backward compatibility)
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

// Server-side location photo deduplication with featured priority
function deduplicateByLocationPhotoServer(hits, maxResults, maxPerPhoto) {
  console.log('🎯 Server-side location photo deduplication:', {
    inputHits: hits.length,
    maxResults: maxResults,
    maxPerPhoto: maxPerPhoto
  });

  // Helper functions
  function getLocationPhoto(product) {
    return product.meta?.location?.details?.location_photo || null;
  }
  
  function getBaseHandle(product) {
    const handle = product.handle || '';
    return handle
      .split('-variant-')[0]
      .split('-v-')[0]
      .replace(/-\d+x\d+$/, '')
      .replace(/-original-painting$/, '')
      .replace(/-print$/, '')
      .replace(/-canvas$/, '')
      .replace(/-paper$/, '');
  }

  function isFeatured(product) {
    return product.meta?.featured === 'yes';
  }

  // Step 1: Remove product variants
  const seenBaseHandles = {};
  const uniqueProducts = [];
  
  hits.forEach(function(product) {
    const baseHandle = getBaseHandle(product);
    if (!seenBaseHandles[baseHandle]) {
      seenBaseHandles[baseHandle] = true;
      uniqueProducts.push(product);
    }
  });

  console.log('📦 After variant deduplication:', uniqueProducts.length);

  // Step 2: Separate featured and regular products
  const featuredProducts = uniqueProducts.filter(isFeatured);
  const regularProducts = uniqueProducts.filter(p => !isFeatured(p));

  console.log('⭐ Featured vs Regular split:', {
    featured: featuredProducts.length,
    regular: regularProducts.length
  });

  // Step 3: Group by location photo
  function groupByLocationPhoto(products) {
    const productsByPhoto = {};
    const productsWithoutPhoto = [];
    
    products.forEach(function(product) {
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
    
    return { productsByPhoto, productsWithoutPhoto };
  }

  const featuredGroups = groupByLocationPhoto(featuredProducts);
  const regularGroups = groupByLocationPhoto(regularProducts);

  // Step 4: Create distribution queues
  function createDistributionQueue(productsByPhoto, maxRounds) {
    const distributionQueue = [];
    const photoUUIDs = Object.keys(productsByPhoto);
    
    for (let round = 0; round < maxRounds; round++) {
      photoUUIDs.forEach(function(uuid) {
        if (productsByPhoto[uuid].length > round) {
          distributionQueue.push({
            uuid: uuid,
            product: productsByPhoto[uuid][round],
            round: round,
            featured: isFeatured(productsByPhoto[uuid][round])
          });
        }
      });
    }
    
    return distributionQueue;
  }

  const featuredQueue = createDistributionQueue(featuredGroups.productsByPhoto, maxPerPhoto);
  const regularQueue = createDistributionQueue(regularGroups.productsByPhoto, maxPerPhoto);

  // Step 5: Distribute products (featured first)
  const result = [];
  const photoCounters = {};

  // Featured products first
  while (result.length < maxResults && featuredQueue.length > 0) {
    const nextItem = featuredQueue.shift();
    const currentCount = photoCounters[nextItem.uuid] || 0;
    
    if (currentCount < maxPerPhoto) {
      result.push(nextItem.product);
      photoCounters[nextItem.uuid] = currentCount + 1;
    }
  }

  // Regular products fill remaining slots
  while (result.length < maxResults && regularQueue.length > 0) {
    const nextItem = regularQueue.shift();
    const currentCount = photoCounters[nextItem.uuid] || 0;
    
    if (currentCount < maxPerPhoto) {
      result.push(nextItem.product);
      photoCounters[nextItem.uuid] = currentCount + 1;
    }
  }

  // Add products without location photo
  const remainingSlots = maxResults - result.length;
  if (remainingSlots > 0) {
    const allProductsWithoutPhoto = featuredGroups.productsWithoutPhoto.concat(regularGroups.productsWithoutPhoto);
    const productsToAdd = allProductsWithoutPhoto.slice(0, remainingSlots);
    result.push(...productsToAdd);
  }

  console.log('✅ Server-side deduplication complete:', {
    totalProducts: result.length,
    featuredCount: result.filter(isFeatured).length,
    regularCount: result.filter(p => !isFeatured(p)).length
  });

  return result;
}

// Generate SSR HTML for fast LCP
function generateSSRCollectionHTML(products, collectionData) {
  const { cityName, totalHits, lat, lng, radiusKm, collectionHandle } = collectionData;
  
  const formatPrice = (price) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
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

  const optimizeImageUrl = (imageUrl) => {
    if (imageUrl && imageUrl.includes('cdn.shopify.com')) {
      // Use _400x instead of _600x for better size match to display dimensions
      return imageUrl.replace(/\.webp(\?.*)?$/i, '_400x.webp$1');
    }
    return imageUrl;
  };

  const formatProductPricing = (product) => {
    const printPrice = product.variants_min_price || 7;
    return `**Drucke ab ${formatPrice(printPrice)}, Originale ab ${formatPrice(50)}**`;
  };

  // Generate product cards HTML
  const productsHTML = products.map((product, index) => {
    const originalImageUrl = product.product_image || product.image || '';
    const optimizedImageUrl = optimizeImageUrl(originalImageUrl);
    const priceDisplay = formatProductPricing(product);
    
    // First 2 images should not be lazy loaded for LCP
    const shouldLazyLoad = index >= 2;
    
    // Use responsive dimensions that work on all screen sizes
    const displayWidth = 400; // Reasonable default that fits mobile and desktop
    const displayHeight = Math.round(displayWidth * 0.75); // 4:3 aspect ratio

    return `
      <div class="masonry-item" data-location-photo="${product.meta?.location?.details?.location_photo || 'no-photo'}">
        <div class="card-wrapper product-card-wrapper">
          <div class="card card--standard card--media">
            <a href="/products/${product.handle}" class="full-unstyled-link">
              ${optimizedImageUrl ? `
                <div class="card__media" style="aspect-ratio: 4/3;">
                  <img 
                    src="${optimizedImageUrl}" 
                    alt="${escapeHtml(product.title)}" 
                    ${shouldLazyLoad ? 'loading="lazy"' : ''}
                    width="${displayWidth}"
                    height="${displayHeight}"
                    style="width: 100%; height: auto; max-width: 100%; object-fit: cover; display: block;"
                    ${index === 0 ? 'fetchpriority="high"' : ''}
                  >
                </div>
              ` : ''}
              <div class="card__content">
                <h3 class="card__heading">${escapeHtml(product.title)}</h3>
                ${priceDisplay ? `<div class="price">${priceDisplay}</div>` : ''}
              </div>
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Complete SSR HTML structure
  return `
    <div class="ssr-geo-results" data-generated="${new Date().toISOString()}" data-city="${escapeHtml(cityName)}">
      <div class="ssr-geo-results__inner">
        <div class="ssr-geo-results__grid">
          <div class="masonry-grid">
            ${productsHTML}
          </div>
        </div>
        <div class="ssr-loading-more" style="text-align: center; padding: 2rem 0; opacity: 0.7;">
          <p>Loading more artwork...</p>
        </div>
      </div>
    </div>

    <script>
      // Mark SSR content as loaded
      console.log('🚀 SSR content rendered for ${escapeHtml(cityName)} - LCP should be fast!');
      
      // Add basic event listeners for product links
      document.addEventListener('DOMContentLoaded', function() {
        const ssrContent = document.querySelector('.ssr-geo-results');
        if (ssrContent) {
          console.log('✅ SSR content initialized:', {
            products: ssrContent.querySelectorAll('.masonry-item').length,
            city: '${escapeHtml(cityName)}',
            generated: ssrContent.dataset.generated
          });
        }
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
      maxPerLocation = 2,
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
    const cacheKey = `nearby:${lat || 'fallback'}:${lng || 'fallback'}:${radiusKm}:${hitsPerPage}:${maxPerLocation}`;
    
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
    const uniqueHits = deduplicateForCollection(searchResponse.hits, maxPerLocation, hitsPerPage);

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

// Pre-generate collection endpoint with location photo deduplication and SSR
app.post('/api/pre-generate-collection', async (req, res) => {
  try {
    const { 
      lat, 
      lng, 
      radiusKm = 30, 
      cityName,
      collectionHandle,
      hitsPerPage = 6, // Fewer for LCP optimization
      forceRegenerate = false
    } = req.body;

    if (!lat || !lng || !cityName) {
      return res.status(400).json({
        error: 'Missing required parameters: lat, lng, cityName'
      });
    }

    console.log(`🏗️ Pre-generating collection with location photo dedup:`, {
      city: cityName,
      location: `${lat}, ${lng}`,
      radius: `${radiusKm}km`,
      handle: collectionHandle,
      maxProducts: hitsPerPage
    });

    // Create cache key
    const cacheKey = `ssr-collection:${cityName}:${lat}:${lng}:${radiusKm}:${hitsPerPage}`;
    
    // Check cache unless force regenerate
    if (!forceRegenerate) {
      const cached = cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        const cacheAge = Math.round((Date.now() - cached.timestamp) / (1000 * 60 * 60));
        console.log(`✅ Returning cached SSR HTML - Age: ${cacheAge} hours`);
        
        return res.json({
          html: cached.data,
          cached: true,
          cacheAge: cacheAge + 'h',
          generated: cached.generated,
          stats: cached.stats
        });
      }
    }

    console.log(`🔍 Generating new SSR HTML for ${cityName}`);

    const client = algoliasearch(
      process.env.ALGOLIA_APP_ID || '9DAT2FR7L3',
      process.env.ALGOLIA_SEARCH_API_KEY || '2daede0d3abc6d559d4fbd37d763d544'
    );

    const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME || 'shopify_products');

    const searchParams = {
      aroundLatLng: `${lat},${lng}`,
      aroundRadius: radiusKm * 1000,
      hitsPerPage: 100, // Get more for better deduplication
      attributesToRetrieve: [
        'title', 'handle', 'product_image', 'image', 'price', 
        'vendor', '_geoloc', 'meta.location.details', 'variants_min_price', 'meta.featured'
      ],
      getRankingInfo: true
    };

    const searchResponse = await index.search('', searchParams);
    
    // Apply location photo deduplication (max 2 per photo)
    const deduplicatedHits = deduplicateByLocationPhotoServer(searchResponse.hits, hitsPerPage, 2);

    const collectionData = { 
      cityName, 
      totalHits: searchResponse.nbHits, 
      lat, 
      lng, 
      radiusKm,
      collectionHandle
    };
    
    const staticHTML = generateSSRCollectionHTML(deduplicatedHits, collectionData);

    // Cache the result
    const cacheData = {
      data: staticHTML,
      timestamp: Date.now(),
      generated: new Date().toISOString(),
      stats: {
        products: deduplicatedHits.length,
        totalHits: searchResponse.nbHits,
        city: cityName,
        searchTime: searchResponse.processingTimeMS
      }
    };

    cache.set(cacheKey, cacheData);

    console.log(`✅ SSR HTML generated for ${cityName}:`, {
      products: deduplicatedHits.length,
      htmlSize: `${Math.round(staticHTML.length / 1024)}KB`,
      processingTime: `${searchResponse.processingTimeMS}ms`
    });

    res.json({
      html: staticHTML,
      cached: false,
      generated: cacheData.generated,
      stats: cacheData.stats
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
  console.log(`🏗️ SSR pre-rendering enabled for fast LCP`);
});

module.exports = app;