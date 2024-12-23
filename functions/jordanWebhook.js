const axios = require('axios');
require('dotenv').config();

// Store configurations (replace with your store API details)
const stores = [
    { 
        domain: '8b744d-1a.myshopify.com', 
        locationID:'68260954221',
        name:"Velvet Me",
        apiKey: process.env.VELVETME_API_KEY, 
        password: process.env.VELVETME_API_PASSWORD, 
        adminUrl: 'https://8b744d-1a.myshopify.com'
    },
    { 
        domain: 'b10986-f4.myshopify.com', 
        locationID:'66852061268',
        name:"Orange Cow Jordan",
        apiKey: process.env.ORANGECOW_API_KEY, 
        password: process.env.ORANGECOW_API_PASSWORD, 
        adminUrl: 'https://b10986-f4.myshopify.com'
    },
    { 
        domain: 'cc88f5-f0.myshopify.com', 
        locationID:'77549502693',
        name:"Giving More Jordan",
        apiKey: process.env.GIVINGMORE_API_KEY, 
        password: process.env.GIVINGMORE_API_PASSWORD, 
        adminUrl: 'https://cc88f5-f0.myshopify.com'
    }
];
// Function to wait for a specific time (in milliseconds)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to handle API requests with rate limiting
const makeApiRequest = async (url, options, retries = 5) => {
    try {
        const response = await axios(url, options);
        
        return response;
    } catch (error) {
        if (error.response && error.response.status === 429 && retries > 0) {
            // Rate limit exceeded, wait for Retry-After header
            const retryAfter = error.response.headers['retry-after'] || 1; // Default to 1 second if not provided
            console.log(`Rate limit exceeded. Retrying in ${retryAfter} seconds...`);
            await delay(retryAfter * 1000); // Wait for the specified time before retrying
            return makeApiRequest(url, options, retries - 1); // Retry after delay
        } else {
            throw error; // For other errors, throw them (e.g., network issues)
        }
    }
};

// Webhook handler to receive inventory updates
exports.handler = async (event, context) => {
    if (!event.body) {
        console.error('No body in request');
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Bad request: no body' })
        };
    }

    let data;
    try {
        data = JSON.parse(event.body); // Try parsing
    } catch (error) {
        console.error('Failed to parse body:', error);
        return {
            statusCode: 400,
            body: JSON.stringify({ message: 'Invalid JSON' })
        };
    }

    const { inventory_item_id, available } = data;
    
    try {
        // Step 1: Identify the triggering store
        const triggeringStore = stores.find((store) =>
            store.domain === event.headers['x-shopify-shop-domain'] 
        );

        if (!triggeringStore) {
            console.error('Store not found based on webhook domain');
            return {
                statusCode: 404,
                body: JSON.stringify({ message: 'Store not found' })
            };
        }

        // Step 2: Fetch SKU for the triggering inventory_item_id
        const productResponse = await makeApiRequest(`${triggeringStore.adminUrl}/admin/api/2024-10/products.json?fields=variants&limit=250`, {
            auth: { username: triggeringStore.apiKey, password: triggeringStore.password },
        });

        const sku = productResponse.data.products
        .flatMap(product => product.variants)
        .find(variant => variant.inventory_item_id === Number(inventory_item_id))?.sku;
        
        if (!sku)  {
            console.error(`SKU not found for inventory_item_id: ${inventory_item_id} in ${triggeringStore.name}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'SKU not found' })
            };
        }
        
        // Step 3: Update inventory in other stores (excluding the triggering store)
        for (const store of stores) {
            if (store.domain === triggeringStore.domain) continue; // Skip the triggering store
        
            const storeProductResponse = await makeApiRequest(`${store.adminUrl}/admin/api/2024-10/products.json?fields=variants&limit=250`, {
                auth: { username: store.apiKey, password: store.password },
            });
        
            const targetInventoryId = storeProductResponse?.data?.products
            ?.flatMap(product => product.variants || []) 
            .find(variant => variant?.sku === sku)?.inventory_item_id;
        
                        
            if (targetInventoryId) {
                // Fetch current inventory level for the target inventory item
                const currentInventoryResponse = await makeApiRequest(
                    `${store.adminUrl}/admin/api/2024-10/inventory_levels.json?inventory_item_ids=${targetInventoryId}`,
                    {
                        auth: { username: store.apiKey, password: store.password },
                    }
                );
        
                const currentInventory = currentInventoryResponse.data.inventory_levels[0]?.available;
                
                if (currentInventory === available) {
                    console.log(`Inventory for item ${targetInventoryId} ,Amount ${available} in store ${store.name} is already up to date. Skipping update.`);
                    continue; // Skip update if inventory is already up-to-date
                }
        
                // Update inventory for the current store
                await makeApiRequest(
                    `${store.adminUrl}/admin/api/2024-10/inventory_levels/set.json`,
                    {
                        method: 'POST',
                        auth: { username: store.apiKey, password: store.password },
                        data: {
                            inventory_item_id: targetInventoryId,
                            available, 
                            location_id: store.locationID 
                        },
                    }
                );
                
                console.log(`Inventory updated for item ${targetInventoryId}, Amount: ${available} in store ${store.name}.`);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Inventory synced successfully (excluding triggering store)' })
        };
    } catch (error) {
        console.error('Error syncing inventory:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Error syncing inventory' })
        };
    }
};
