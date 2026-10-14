
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

        // Free orders do not require payment.
        if (data.freeOrder === true && data.orderNumber) {
            resetCartAfterOrder();

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
                resetCartAfterOrder();

                // Show the Order ID immediately.
                const statusElement = showCheckoutSuccess(
                    data.orderNumber,
                    hasPaperback,
                    'Payment received. Verifying payment...'
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
                        setOrderStatus(
                            statusElement,
                            'Payment verified successfully. Thank you for your purchase!'
                        );
                    } else {
                        setOrderStatus(
                            statusElement,
                            'Payment verification is pending. Please keep your Order ID.'
                        );

                        console.error('Payment verification needs follow-up:', result);
                    }
                } catch (error) {
                    setOrderStatus(
                        statusElement,
                        'Payment verification is delayed. Please check your order status later.'
                    );

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

function resetCartAfterOrder() {
    document.getElementById('cart-modal')?.classList.add('hidden');
    cart = [];
    saveCart();
    updateCartUI();
}

function showCheckoutSuccess(orderNumber, hasPaperback, statusMessage) {
    const modal = document.getElementById('order-success-modal');
    const idElement = document.getElementById('confirmed-order-id');

    if (!modal || !idElement) {
        alert(`Order ID: ${orderNumber}\n${statusMessage}`);
        return null;
    }

    idElement.textContent = orderNumber;

    // Remove the old email-related status and duplicate static payment message.
    modal.querySelectorAll('#confirmation-email-status, #order-confirmation-status')
        .forEach(element => element.remove());

    const card = modal.querySelector('[role="dialog"]') ||
        modal.querySelector('.order-success-card') ||
        idElement.closest('.bg-white') ||
        modal.firstElementChild ||
        modal;

    let statusElement = document.getElementById('checkout-order-status');

    if (!statusElement) {
        statusElement = document.createElement('p');
        statusElement.id = 'checkout-order-status';
        statusElement.style.marginTop = '12px';
        idElement.parentElement?.appendChild(statusElement);
    }

    statusElement.textContent = statusMessage;

    let notice = document.getElementById('paperback-delivery-notice');

    if (!notice) {
        notice = document.createElement('p');
        notice.id = 'paperback-delivery-notice';
        notice.style.marginTop = '12px';
        notice.style.lineHeight = '1.5';
        card.appendChild(notice);
    }

    notice.textContent = hasPaperback
        ? 'Thank you for your purchase! Your paperback order will be delivered to the provided address within the next 30 days.'
        : '';

    notice.style.display = hasPaperback ? 'block' : 'none';

    let continueButton = document.getElementById('continue-browsing-button');

    if (!continueButton) {
        continueButton = document.createElement('button');
        continueButton.id = 'continue-browsing-button';
        continueButton.type = 'button';
        continueButton.textContent = 'Continue Browsing';
        continueButton.className =
            'mt-4 w-full rounded-lg border border-gray-300 px-4 py-3 font-semibold';

        continueButton.addEventListener('click', function () {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            window.location.href = 'books.html';
        });

        card.appendChild(continueButton);
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');

    return statusElement;
}

function setOrderStatus(element, message) {
    if (element) {
        element.textContent = message;
    }
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
        if (status) {
            status.textContent = 'Please select and copy the Order ID manually.';
        }
    }
}

function closeOrderConfirmation() {
    const modal = document.getElementById('order-confirmation-modal');

    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
}
