// Mock restaurant data - simulates DoorDash API responses
// Later this can be replaced with real API calls or browser automation

const restaurants = [
    {
        id: 'chipotle-1',
        name: 'Chipotle Mexican Grill',
        cuisine: 'mexican',
        rating: 4.5,
        deliveryTime: '25-35 min',
        deliveryFee: 2.99,
        distance: '0.8 mi',
        priceLevel: '$$',
        menu: [
            { id: 'burrito', name: 'Burrito', price: 10.95, description: 'Choice of protein, rice, beans, salsa, and toppings in a flour tortilla',
              requiredOptions: { protein: ['Chicken', 'Steak (+$2)', 'Carnitas', 'Barbacoa (+$2)', 'Sofritas', 'Veggie'] } },
            { id: 'bowl', name: 'Burrito Bowl', price: 10.95, description: 'All the burrito fillings without the tortilla',
              requiredOptions: { protein: ['Chicken', 'Steak (+$2)', 'Carnitas', 'Barbacoa (+$2)', 'Sofritas', 'Veggie'] } },
            { id: 'tacos', name: 'Tacos (3)', price: 10.95, description: 'Three soft or crispy tacos with your choice of protein',
              requiredOptions: { protein: ['Chicken', 'Steak (+$2)', 'Carnitas', 'Barbacoa (+$2)', 'Sofritas', 'Veggie'] } },
            { id: 'quesadilla', name: 'Quesadilla', price: 11.95, description: 'Grilled flour tortilla with cheese and protein',
              requiredOptions: { protein: ['Chicken', 'Steak (+$2)', 'Carnitas', 'Barbacoa (+$2)', 'Sofritas', 'Veggie'] } },
            { id: 'chips-guac', name: 'Chips & Guacamole', price: 5.95, description: 'Fresh tortilla chips with hand-mashed guac' },
            { id: 'chips-salsa', name: 'Chips & Salsa', price: 2.95, description: 'Fresh tortilla chips with your choice of salsa' },
        ]
    },
    {
        id: 'taco-bell-1',
        name: 'Taco Bell',
        cuisine: 'mexican',
        rating: 4.0,
        deliveryTime: '15-25 min',
        deliveryFee: 1.99,
        distance: '0.5 mi',
        priceLevel: '$',
        menu: [
            { id: 'crunchwrap', name: 'Crunchwrap Supreme', price: 5.49, description: 'Seasoned beef, nacho cheese, lettuce, tomato, sour cream in a grilled tortilla' },
            { id: 'chalupa', name: 'Chalupa Supreme', price: 4.49, description: 'Fried chalupa shell with beef, cheese, lettuce, tomato, sour cream' },
            { id: 'burrito-supreme', name: 'Burrito Supreme', price: 4.99, description: 'Seasoned beef, beans, rice, cheese, sour cream, lettuce, tomato' },
            { id: 'mexican-pizza', name: 'Mexican Pizza', price: 5.49, description: 'Two crispy shells with beef, beans, pizza sauce, cheese, tomatoes' },
            { id: 'nachos-bellgrande', name: 'Nachos BellGrande', price: 5.99, description: 'Chips with beef, beans, nacho cheese, sour cream, tomatoes' },
            { id: 'taco-12pack', name: 'Taco 12-Pack', price: 15.99, description: '12 crunchy tacos for sharing' },
        ]
    },
    {
        id: 'panda-1',
        name: 'Panda Express',
        cuisine: 'chinese',
        rating: 4.2,
        deliveryTime: '20-30 min',
        deliveryFee: 2.49,
        distance: '1.2 mi',
        priceLevel: '$$',
        menu: [
            { id: 'orange-chicken', name: 'Orange Chicken', price: 9.99, description: 'Crispy chicken wok-tossed in sweet and spicy orange sauce' },
            { id: 'beijing-beef', name: 'Beijing Beef', price: 9.99, description: 'Crispy beef with bell peppers in sweet-tangy sauce' },
            { id: 'kung-pao', name: 'Kung Pao Chicken', price: 9.99, description: 'Chicken with peanuts, peppers in spicy Sichuan sauce' },
            { id: 'chow-mein', name: 'Chow Mein', price: 4.50, description: 'Stir-fried noodles with cabbage, celery, onions' },
            { id: 'fried-rice', name: 'Fried Rice', price: 4.50, description: 'Wok-fired rice with egg, peas, carrots' },
            { id: 'plate', name: '2-Entree Plate', price: 11.50, description: 'Choose 2 entrees and 1 side' },
        ]
    },
    {
        id: 'mcdonalds-1',
        name: "McDonald's",
        cuisine: 'american',
        rating: 3.8,
        deliveryTime: '15-20 min',
        deliveryFee: 0.99,
        distance: '0.3 mi',
        priceLevel: '$',
        menu: [
            { id: 'big-mac', name: 'Big Mac', price: 6.49, description: 'Two beef patties, special sauce, lettuce, cheese, pickles, onions' },
            { id: 'quarter-pounder', name: 'Quarter Pounder with Cheese', price: 6.99, description: 'Quarter pound beef patty with cheese, onions, pickles' },
            { id: 'mcnuggets-10', name: '10 Piece McNuggets', price: 6.49, description: 'Crispy chicken nuggets with your choice of sauce' },
            { id: 'fries-large', name: 'Large Fries', price: 3.99, description: 'Golden crispy fries' },
            { id: 'mcflurry', name: 'McFlurry', price: 4.49, description: 'Soft serve with your choice of candy mix-in' },
            { id: 'big-mac-meal', name: 'Big Mac Meal', price: 10.99, description: 'Big Mac, medium fries, and medium drink' },
        ]
    },
    {
        id: 'pizza-hut-1',
        name: 'Pizza Hut',
        cuisine: 'pizza',
        rating: 4.1,
        deliveryTime: '30-45 min',
        deliveryFee: 3.99,
        distance: '1.5 mi',
        priceLevel: '$$',
        menu: [
            { id: 'pepperoni-large', name: 'Large Pepperoni Pizza', price: 15.99, description: 'Classic pepperoni on hand-tossed crust' },
            { id: 'supreme-large', name: 'Large Supreme Pizza', price: 18.99, description: 'Pepperoni, sausage, peppers, onions, mushrooms' },
            { id: 'cheese-large', name: 'Large Cheese Pizza', price: 13.99, description: 'Mozzarella cheese on hand-tossed crust' },
            { id: 'wings-8', name: 'Bone-In Wings (8pc)', price: 10.99, description: 'Traditional wings with your choice of sauce' },
            { id: 'breadsticks', name: 'Breadsticks (5pc)', price: 5.99, description: 'Baked breadsticks with marinara dipping sauce' },
            { id: 'cookie', name: 'Ultimate Hershey\'s Cookie', price: 6.99, description: 'Warm chocolate chip cookie for sharing' },
        ]
    },
    {
        id: 'subway-1',
        name: 'Subway',
        cuisine: 'sandwiches',
        rating: 4.0,
        deliveryTime: '20-30 min',
        deliveryFee: 1.49,
        distance: '0.6 mi',
        priceLevel: '$',
        menu: [
            { id: 'italian-bmt', name: 'Italian B.M.T. Footlong', price: 9.99, description: 'Genoa salami, spicy pepperoni, Black Forest ham' },
            { id: 'turkey', name: 'Turkey Breast Footlong', price: 9.49, description: 'Sliced turkey breast with your choice of veggies' },
            { id: 'meatball', name: 'Meatball Marinara Footlong', price: 8.99, description: 'Italian meatballs in marinara sauce with cheese' },
            { id: 'steak-cheese', name: 'Steak & Cheese Footlong', price: 10.99, description: 'Shaved steak with melted cheese' },
            { id: 'veggie', name: 'Veggie Delite Footlong', price: 7.49, description: 'Fresh veggies on freshly baked bread' },
            { id: 'cookies', name: 'Cookies (3)', price: 2.49, description: 'Three freshly baked cookies' },
        ]
    },
    {
        id: 'el-pollo-1',
        name: 'El Pollo Loco',
        cuisine: 'mexican',
        rating: 4.3,
        deliveryTime: '25-35 min',
        deliveryFee: 2.99,
        distance: '1.0 mi',
        priceLevel: '$$',
        menu: [
            { id: 'chicken-meal', name: '2pc Chicken Meal', price: 9.99, description: 'Fire-grilled chicken with beans, rice, tortillas' },
            { id: 'burrito-pollo', name: 'Classic Chicken Burrito', price: 8.49, description: 'Grilled chicken, rice, beans, cheese, salsa in flour tortilla' },
            { id: 'tacos-chicken', name: 'Chicken Tacos (3)', price: 8.99, description: 'Fire-grilled chicken in soft tortillas with cilantro and onion' },
            { id: 'bowl-pollo', name: 'Pollo Bowl', price: 9.49, description: 'Rice bowl with fire-grilled chicken and fresh toppings' },
            { id: 'quesadilla-pollo', name: 'Chicken Quesadilla', price: 8.99, description: 'Grilled flour tortilla with chicken and melted cheese' },
            { id: 'family-meal', name: 'Family Meal (8pc)', price: 29.99, description: '8 pieces of chicken with large sides and tortillas' },
        ]
    }
];

// Search restaurants by cuisine or keyword
function searchRestaurants(query, userPreferences = {}) {
    const searchTerm = query.toLowerCase();

    let results = restaurants.filter(r => {
        return r.cuisine.includes(searchTerm) ||
               r.name.toLowerCase().includes(searchTerm) ||
               r.menu.some(item => item.name.toLowerCase().includes(searchTerm));
    });

    // If no specific results, return some popular options
    if (results.length === 0) {
        results = restaurants.slice(0, 3);
    }

    // Sort by rating and delivery time
    results.sort((a, b) => {
        const aTime = parseInt(a.deliveryTime);
        const bTime = parseInt(b.deliveryTime);
        // Prioritize faster delivery, then higher rating
        if (Math.abs(aTime - bTime) > 10) return aTime - bTime;
        return b.rating - a.rating;
    });

    return results.slice(0, 4); // Return top 4
}

// Get restaurant by ID
function getRestaurant(restaurantId) {
    return restaurants.find(r => r.id === restaurantId);
}

// Get menu item by ID
function getMenuItem(restaurantId, itemId) {
    const restaurant = getRestaurant(restaurantId);
    if (!restaurant) return null;
    return restaurant.menu.find(item => item.id === itemId);
}

// Format restaurant for SMS display
function formatRestaurantList(restaurants) {
    return restaurants.map((r, i) =>
        `${i + 1}. ${r.name.toUpperCase()}\n   ★ ${r.rating} · ${r.deliveryTime} · ${r.priceLevel}\n   Delivery: $${r.deliveryFee}`
    ).join('\n\n');
}

// Format menu for SMS display
function formatMenu(restaurant) {
    let text = `══════════════════\n`;
    text += `  ${restaurant.name.toUpperCase()}\n`;
    text += `══════════════════\n\n`;
    text += restaurant.menu.map((item, i) =>
        `${i + 1}. ${item.name.toUpperCase()}\n   $${item.price.toFixed(2)} · ${item.description}`
    ).join('\n\n');
    return text;
}

// Calculate order total
function calculateOrderTotal(items, restaurant) {
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const deliveryFee = restaurant.deliveryFee;
    const serviceFee = subtotal * 0.15; // 15% service fee
    const tax = subtotal * 0.0825; // 8.25% tax (Texas)
    const total = subtotal + deliveryFee + serviceFee + tax;

    return {
        subtotal: subtotal.toFixed(2),
        deliveryFee: deliveryFee.toFixed(2),
        serviceFee: serviceFee.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2)
    };
}

// Format cart for SMS display - supports multiple restaurants
function formatCart(cart, currentRestaurant) {
    // Handle new multi-restaurant format
    const cartItems = cart.items || {};
    const restaurantIds = Object.keys(cartItems);

    if (restaurantIds.length === 0) {
        return 'Your cart is empty.';
    }

    let text = `══════════════════\n`;
    text += `  YOUR ORDER\n`;
    text += `══════════════════\n\n`;

    let grandSubtotal = 0;
    let totalDeliveryFee = 0;
    let allItems = [];

    restaurantIds.forEach((restaurantId, idx) => {
        const restaurant = getRestaurant(restaurantId);
        const items = cartItems[restaurantId];
        if (!items || items.length === 0) return;

        // Handle both mock restaurants and DoorDash restaurants
        const restaurantName = restaurant?.name || 'DoorDash Order';
        const deliveryFee = restaurant?.deliveryFee || 2.99; // Default DoorDash fee

        if (restaurantIds.length > 1) {
            text += `📍 ${restaurantName}\n`;
            text += `──────────────────\n`;
        } else {
            text += `${restaurantName}\n──────────────────\n`;
        }

        items.forEach(item => {
            const itemPrice = parseFloat(item.price) || 0;
            const quantity = item.quantity || 1;
            // Clean up item name (remove rating info for display)
            const cleanName = item.name.split('•')[0].trim();
            text += `${quantity}x ${cleanName}\n   $${(itemPrice * quantity).toFixed(2)}\n`;
            grandSubtotal += itemPrice * quantity;
            allItems.push(item);
        });

        totalDeliveryFee += deliveryFee;

        if (idx < restaurantIds.length - 1) {
            text += `\n`;
        }
    });

    const serviceFee = grandSubtotal * 0.15;
    const tax = grandSubtotal * 0.0825;
    const total = grandSubtotal + totalDeliveryFee + serviceFee + tax;

    text += `\n──────────────────\n`;
    text += `Subtotal:      $${grandSubtotal.toFixed(2)}\n`;
    text += `Delivery:      $${totalDeliveryFee.toFixed(2)}`;
    if (restaurantIds.length > 1) {
        text += ` (${restaurantIds.length} stops)`;
    }
    text += `\n`;
    text += `Service Fee:   $${serviceFee.toFixed(2)}\n`;
    text += `Tax:           $${tax.toFixed(2)}\n`;
    text += `──────────────────\n`;
    text += `TOTAL:         $${total.toFixed(2)}`;

    return text;
}

// Calculate order total for multi-restaurant cart
function calculateMultiOrderTotal(cart) {
    const cartItems = cart.items || {};
    const restaurantIds = Object.keys(cartItems);

    let grandSubtotal = 0;
    let totalDeliveryFee = 0;

    restaurantIds.forEach(restaurantId => {
        const restaurant = getRestaurant(restaurantId);
        const items = cartItems[restaurantId];
        if (!restaurant || !items) return;

        items.forEach(item => {
            grandSubtotal += item.price * item.quantity;
        });
        totalDeliveryFee += restaurant.deliveryFee;
    });

    const serviceFee = grandSubtotal * 0.15;
    const tax = grandSubtotal * 0.0825;
    const total = grandSubtotal + totalDeliveryFee + serviceFee + tax;

    return {
        subtotal: grandSubtotal.toFixed(2),
        deliveryFee: totalDeliveryFee.toFixed(2),
        serviceFee: serviceFee.toFixed(2),
        tax: tax.toFixed(2),
        total: total.toFixed(2)
    };
}

module.exports = {
    restaurants,
    searchRestaurants,
    getRestaurant,
    getMenuItem,
    formatRestaurantList,
    formatMenu,
    formatCart,
    calculateOrderTotal,
    calculateMultiOrderTotal
};
