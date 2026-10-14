// Checkout flow: close/reset the cart and show a dedicated Order ID confirmation modal.

async function checkout() {
    if (checkoutInProgress) return;

    const email = document.getElementById('customer-email')?.value.trim() || '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        alert('Please enter a valid email address.');
        return;
    }

    if (!cart.length) {
        alert('Your cart is empty.');
        return;
    }

    const hasPaperback = cart.some(item => String(item.id).endsWith('_pb'));
    let shippingAddress = null;

    if (hasPaperback) {
        const address = document.getElementById('ship-address')?.value.trim() || '';
        const city = document.getElementById('ship-city')?.value.trim() || '';
        const pincode = document.getElementById('ship-pincode')?.value.trim() || '';

        if (!address || !city || !/^\d{6}$/.test(pincode)) {
            alert('Enter your street address, city and valid 6-digit PIN code.');
            return;
        }

        shippingAddress = { address, city, pincode };
    }

    checkoutInProgress = true;

    try {
        const response = await fetch(`${API_URL}/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: cart,
                customerEmail: email,
                shippingAddress
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not create your order. Please try again.');
        }

        // Free orders do not require Razorpay.
        if (data.freeOrder === true && data.orderNumber) {
            document.getElementById('cart-modal')?.classList.add('hidden');

            cart = [];
            saveCart();
            updateCartUI();

            showCheckoutSuccess(
                data.orderNumber,
                hasPaperback,
                'Your order is confirmed. No payment was required.'
            );

            checkoutInProgress = false;
            return;
        }

        if (!data.orderId || !data.keyId || !data.orderNumber) {
            throw new Error(
                data.error || 'Payment details are missing. Please contact support before retrying.'
            );
        }

        if (typeof window.Razorpay !== 'function') {
            throw new Error('Payment checkout could not load. Please refresh and try again.');
        }

        const options = {
            key: data.keyId,
            amount: data.amount,
            currency: data.currency || 'INR',
            name: 'Sai Krishna Author Store',
            description: 'Book Purchase',
            order_id: data.orderId,
            prefill: { email },
            theme: { color: '#4f46e5' },

            handler: async function (paymentResponse) {
                document.getElementById('cart-modal')?.classList.add('hidden');

                cart = [];
                saveCart();
                updateCartUI();

                // Display Order ID immediately, without waiting for verification.
                const statusElement = showCheckoutSuccess(
                    data.orderNumber,
                    hasPaperback,
                    'Payment received. Verifying payment securely...'
                );

                try {
                    const verifyResponse = await fetch(`${API_URL}/api/verify-payment`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razorpay_order_id: paymentResponse.razorpay_order_id,
                            razorpay_payment_id: paymentResponse.razorpay_payment_id,
                            razorpay_signature: paymentResponse.razorpay_signature
                        })
                    });

                    const result = await verifyResponse.json().catch(() => ({}));

                    if (verifyResponse.ok && result.success) {
                        if (statusElement) {
                            statusElement.textContent = 'Payment verified successfully. Thank you for your purchase!';
                        }
                    } else {
                        if (statusElement) {
                            statusElement.textContent =
                                'Payment verification is pending. Please keep your Order ID.';
                        }
                        console.error('Payment verification needs follow-up:', result);
                    }
                } catch (error) {
                    if (statusElement) {
                        statusElement.textContent =
                            'Payment verification is delayed. Please keep your Order ID and check your order status.';
                    }
                    console.error('Payment verification request failed:', error);
                } finally {
                    checkoutInProgress = false;
                }
            },

            modal: {
                ondismiss: function () {
                    checkoutInProgress = false;
                }
            }
        };

        const razorpay = new window.Razorpay(options);

        razorpay.on('payment.failed', function (event) {
            checkoutInProgress = false;
            console.error('Razorpay payment failed:', event.error);
            alert(
                event.error?.description ||
                'Payment failed. Check your payment status before trying again.'
            );
        });

        razorpay.open();
    } catch (error) {
        checkoutInProgress = false;
        console.error('Checkout failed:', error);
        alert(error.message || 'Checkout failed. Please try again.');
    }
}

function showCheckoutSuccess(orderNumber, hasPaperback, statusMessage) {
    const modal = document.getElementById('order-success-modal');
    const idElement = document.getElementById('confirmed-order-id');

    if (idElement) {
        idElement.textContent = orderNumber;
    }

    let statusElement = document.getElementById('checkout-order-status');

    if (!statusElement && modal) {
        statusElement = document.createElement('p');
        statusElement.id = 'checkout-order-status';
        statusElement.style.marginTop = '12px';

        const idElementParent = idElement?.parentElement || modal;
        idElementParent.appendChild(statusElement);
    }

    if (statusElement) {
        statusElement.textContent = statusMessage;
    }

    addPaperbackDeliveryNotice(modal, hasPaperback);

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    } else {
        alert(`Order ID: ${orderNumber}\n${statusMessage}`);
    }

    return statusElement;
}

function showOrderConfirmation(orderNumber, statusMessage) {
    const idElement = document.getElementById('confirmed-order-id');
    const statusElement = document.getElementById('order-confirmation-status');
    const modal = document.getElementById('order-confirmation-modal');
    if (!idElement || !statusElement || !modal) {
        console.error('Order confirmation modal is missing from books.html.');
        alert(`Your Order ID: ${orderNumber}\n${statusMessage}`);
        return;
    }
    idElement.textContent = orderNumber;
    statusElement.textContent = statusMessage;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

async function copyOrderId() {
    const idElement = document.getElementById('confirmed-order-id');
    const status = document.getElementById('copy-order-status');
    const orderNumber = idElement?.textContent?.trim() || '';
    if (!orderNumber) return;
    try {
        await navigator.clipboard.writeText(orderNumber);
        if (status) status.textContent = 'Order ID copied!';
    } catch {
        if (status) status.textContent = 'Please select and copy the Order ID manually.';
    }
}

function closeOrderConfirmation() {
    const modal = document.getElementById('order-confirmation-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
}


function addPaperbackDeliveryNotice(modal, hasPaperback) {
    if (!modal) return;

    let notice = document.getElementById('paperback-delivery-notice');

    if (!notice) {
        notice = document.createElement('p');
        notice.id = 'paperback-delivery-notice';
        notice.style.marginTop = '12px';
        notice.style.lineHeight = '1.5';
        modal.appendChild(notice);
    }

    notice.textContent = hasPaperback
        ? 'Thank you for your purchase! Your paperback order will be delivered to the provided address within the next 30 days.'
        : '';

    notice.style.display = hasPaperback ? 'block' : 'none';

    let button = document.getElementById('continue-browsing-button');

    if (!button) {
        button = document.createElement('button');
        button.id = 'continue-browsing-button';
        button.type = 'button';
        button.textContent = 'Continue Browsing';
        button.style.marginTop = '16px';
        button.style.padding = '10px 16px';
        button.style.cursor = 'pointer';

        button.onclick = function () {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            window.location.href = 'books.html';
        };

        modal.appendChild(button);
    }
}
