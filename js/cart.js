// Modularized from the working cart.js; function bodies preserved.

function loadCart() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(CART_STORAGE_KEY) || '[]'
    );

    if (!Array.isArray(saved)) return [];

    return saved
      .filter(item =>
        item &&
        typeof item.id === 'string' &&
        item.name &&
        Number.isFinite(Number(item.price)) &&
        Number(item.price) >= 0
      )
      .map(item => ({
        id: item.id,
        name: String(item.name),
        price: Number(item.price),
        quantity: Math.max(
          1,
          Math.floor(Number(item.quantity) || 1)
        )
      }));
  } catch (error) {
    console.warn('Could not read saved cart:', error);
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify(cart)
    );
  } catch (error) {
    console.error('Could not save cart:', error);
  }
}

function toggleCart() {
  document.getElementById('cart-modal')
    ?.classList.toggle('hidden');
}

function addToCart(bookId, bookName, bookPrice) {
  const price = Number(bookPrice);

  if (!bookId || !Number.isFinite(price) || price < 0) {
    alert('This book could not be added. Please refresh and try again.');
    return;
  }

  const existing = cart.find(item => item.id === bookId);

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: bookId,
      name: bookName,
      price,
      quantity: 1
    });
  }

  saveCart();
  updateCartUI();

  const modal = document.getElementById('cart-modal');

  if (modal?.classList.contains('hidden')) {
    modal.classList.remove('hidden');
  }
}

function increaseQuantity(bookId) {
  const item = cart.find(entry => entry.id === bookId);

  if (item) {
    item.quantity += 1;
    saveCart();
    updateCartUI();
  }
}

function decreaseQuantity(bookId) {
  const item = cart.find(entry => entry.id === bookId);

  if (!item) return;

  item.quantity -= 1;

  if (item.quantity <= 0) {
    cart = cart.filter(entry => entry.id !== bookId);
  }

  saveCart();
  updateCartUI();
}

function removeFromCart(bookId) {
  cart = cart.filter(item => item.id !== bookId);
  saveCart();
  updateCartUI();
}

function updateCartUI() {
    document.getElementById('cart-count').innerText = cart.reduce((sum, item) => sum + item.quantity, 0);
    const container = document.getElementById('cart-items');
    
    const hasPaperback = cart.some(item => item.id.includes('_pb'));
    
    let shippingContainer = document.getElementById('dynamic-shipping-section');
    if (hasPaperback) {
        if (!shippingContainer) {
            shippingContainer = document.createElement('div');
            shippingContainer.id = 'dynamic-shipping-section';
            shippingContainer.className = 'space-y-3 border-t pt-3 mt-3';
            shippingContainer.innerHTML = `
                <h4 class="font-bold text-sm text-gray-800">🚚 Shipping Address (For Paperback Delivery)</h4>
                <input type="text" id="ship-address" placeholder="Street Address / House No." class="w-full border rounded-lg px-3 py-1.5 text-sm">
                <div class="grid grid-cols-2 gap-2">
                    <input type="text" id="ship-city" placeholder="City" class="border rounded-lg px-3 py-1.5 text-sm">
                    <input type="text" id="ship-pincode" placeholder="Pincode" class="border rounded-lg px-3 py-1.5 text-sm">
                </div>
            `;
            const emailInput = document.getElementById('customer-email').parentNode;
            emailInput.parentNode.insertBefore(shippingContainer, emailInput);
        }
    } else {
        if (shippingContainer) shippingContainer.remove();
    }

    if (cart.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-center py-12">Your cart is empty.</p>';
        document.getElementById('cart-total').innerText = '0';
        return;
    }

    container.innerHTML = cart.map(item => `
        <div class="flex justify-between items-center border-b pb-3 space-x-2">
            <div class="flex-1">
                <h4 class="font-bold text-gray-800 text-sm">${item.name}</h4>
                <p class="text-xs text-gray-500">₹${item.price} each</p>
            </div>
            <div class="flex items-center space-x-2">
                <div class="flex items-center border rounded bg-gray-50">
                    <button onclick="decreaseQuantity('${item.id}')" class="px-2 py-0.5 text-gray-600 hover:bg-gray-200 font-bold">-</button>
                    <span class="px-2 text-xs font-semibold">${item.quantity}</span>
                    <button onclick="increaseQuantity('${item.id}')" class="px-2 py-0.5 text-gray-600 hover:bg-gray-200 font-bold">+</button>
                </div>
                <span class="font-bold text-gray-900 text-sm min-w-[50px] text-right">₹${item.price * item.quantity}</span>
                <button onclick="removeFromCart('${item.id}')" class="text-red-500 hover:text-red-700 text-xs font-semibold px-1.5 py-1 bg-red-50 rounded" title="Remove Item">✕</button>
            </div>
        </div>
    `).join('');

    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    document.getElementById('cart-total').innerText = total;
}
