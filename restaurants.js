// Restaurant utilities — cart display and order total helpers
// Mock restaurant data has been removed. The system always uses real DoorDash.

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
        const items = cartItems[restaurantId];
        if (!items || items.length === 0) return;

        // Use restaurant name from cart items (DoorDash always stores name in cart)
        const restaurantName = items[0]?.restaurantName || 'DoorDash Order';
        const deliveryFee = 2.99; // Default DoorDash fee

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
        const items = cartItems[restaurantId];
        if (!items) return;

        items.forEach(item => {
            grandSubtotal += (parseFloat(item.price) || 0) * (item.quantity || 1);
        });
        totalDeliveryFee += 2.99; // Default DoorDash delivery fee
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
    formatCart,
    calculateOrderTotal,
    calculateMultiOrderTotal
};
