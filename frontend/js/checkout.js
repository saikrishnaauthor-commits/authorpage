// Checkout flow: close/reset the cart and show a dedicated Order ID confirmation modal.
a
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
        const orderedItems = [...cart];

        const response = await fetch(`${API_URL}/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: orderedItems,
                customerEmail: email,
                shippingAddress
            })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(data.error || 'Could not create your order.');
        }

        // Free orders: no Razorpay payment required.
        if (data.success && data.freeOrder && data.orderNumber) {
            document.getElementById('cart-modal')?.classList.add('hidden');

            cart = [];
            saveCart();
            updateCartUI();

            showOrderConfirmation(data.orderNumber, orderedItems);
            checkoutInProgress = false;
            return;
        }

        // Paid orders must have valid Razorpay details.
        if (!data.orderId || !data.keyId || !data.orderNumber) {
            throw new Error(
                'The server did not return the required payment details. Please contact support.'
            );
        }

        if (typeof window.Razorpay !== 'function') {
            throw new Error(
                'Payment checkout could not load. Please refresh and try again.'
            );
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
                const emailStatus =
                    document.getElementById('confirmation-email-status');

                try {
                    const verifyResponse = await fetch(
                        `${API_URL}/api/verify-payment`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                razorpay_order_id: paymentResponse.razorpay_order_id,
                                razorpay_payment_id: paymentResponse.razorpay_payment_id,
                                razorpay_signature: paymentResponse.razorpay_signature
                            })
                        }
                    );

                    const result = await verifyResponse.json().catch(() => ({}));

                    if (!verifyResponse.ok || !result.success) {
                        if (emailStatus) {
                            emailStatus.textContent =
                                'Payment verification is pending. Keep your Order ID and check Order Status before retrying.';
                        }

                        console.error('Payment verification needs follow-up:', result);
                        return;
                    }

                    // Show confirmation only after payment verification succeeds.
                    document.getElementById('cart-modal')?.classList.add('hidden');

                    cart = [];
                    saveCart();
                    updateCartUI();

                    showOrderConfirmation(data.orderNumber, orderedItems);

                    if (emailStatus) {
                        emailStatus.textContent = result.emailSent
                            ? 'Payment verified. Your confirmation email has been sent.'
                            : 'Payment verified. Your confirmation email may be delayed.';
                    }
                } catch (error) {
                    if (emailStatus) {
                        emailStatus.textContent =
                            'Payment verification is pending. Keep your Order ID and check Order Status before retrying.';
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


function showOrderConfirmation(orderNumber, items = []) {
    const idElement = document.getElementById('confirmed-order-id');
    const details = document.getElementById('confirmation-details');
    const status = document.getElementById('confirmation-email-status');
    const modal = document.getElementById('order-success-modal');
    const ebooksButton = document.getElementById('confirmation-ebooks-button');

    if (!idElement || !details || !modal) {
        console.error('Order confirmation elements are missing.');
        return;
    }

    idElement.textContent = orderNumber;
    if (status) status.textContent = '';

    const hasPaperback = items.some(item => String(item.id).endsWith('_pb'));
    const hasEbook = items.some(item => String(item.id).endsWith('_eb'));

    details.replaceChildren();

    if (hasPaperback) {
        const delivery = document.createElement('p');
        delivery.className = 'text-gray-700';
        delivery.textContent =
            '📦 Your paperback book will be delivered within 30 days.';
        details.appendChild(delivery);
    }

    if (hasEbook) {
        const ebookMessage = document.createElement('p');
        ebookMessage.className = 'text-gray-700';
        ebookMessage.textContent =
            'To access your e-book, go to My E-books and sign in using your Order ID and the email address used for your order.';
        details.appendChild(ebookMessage);
    }

    if (ebooksButton) {
        ebooksButton.classList.toggle('hidden', !hasEbook);
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeOrderSuccess() {
    const modal = document.getElementById('order-success-modal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
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
        if (status) status.textContent =
            'Please select and copy the Order ID manually.';
    }
}




