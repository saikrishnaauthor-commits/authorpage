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
            body: JSON.stringify({ items: cart, customerEmail: email, shippingAddress })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Could not create your order. Please try again.');
        }

        // A zero-total order is completed by the backend without opening Razorpay.
        if (data.freeOrder === true && data.orderNumber) {
            document.getElementById('cart-modal')?.classList.add('hidden');
            cart = [];
            saveCart();
            updateCartUI();

            const modal = document.getElementById('order-success-modal');
            const orderIdElement = document.getElementById('confirmed-order-id');
            const emailStatus = document.getElementById('confirmation-email-status');
            if (orderIdElement) orderIdElement.textContent = data.orderNumber;
            if (emailStatus) {
                emailStatus.textContent = data.emailSent
                    ? 'Your free order is confirmed. Confirmation email sent; use this Order ID and email to access your e-book.'
                    : 'Your free order is confirmed. No payment was required. Save this Order ID; email delivery may be delayed.';
            }
            if (modal) {
                modal.classList.remove('hidden');
                modal.classList.add('flex');
            } else {
                alert(`Your free order is confirmed. Order ID: ${data.orderNumber}`);
            }
            checkoutInProgress = false;
            return;
        }

        if (!data.orderId || !data.keyId || !data.orderNumber) {
            throw new Error(data.error || 'The server did not return payment details. Please contact support before retrying.');
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
                // Close the cart.
                document.getElementById('cart-modal')?.classList.add('hidden');

                // Clear the cart and refresh its display.
                cart = [];
                saveCart();
                updateCartUI();

                // Display the order number returned by the backend.
                const modal = document.getElementById('order-success-modal');
                const orderIdElement = document.getElementById('confirmed-order-id');
                const emailStatus = document.getElementById('confirmation-email-status');

                if (orderIdElement) {
                    orderIdElement.textContent =
                        data.orderNumber || 'Order ID unavailable';
                }

                if (emailStatus) {
                    emailStatus.textContent =
                        'Payment verification is in progress.';
                }

                if (modal) {
                    modal.classList.remove('hidden');
                    modal.classList.add('flex');
                }

                // Verify the payment securely on the backend.
                try {
                    const response = await fetch(`${API_URL}/api/verify-payment`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            razorpay_order_id: paymentResponse.razorpay_order_id,
                            razorpay_payment_id: paymentResponse.razorpay_payment_id,
                            razorpay_signature: paymentResponse.razorpay_signature
                        })
                    });

                    const result = await response.json().catch(() => ({}));

                    if (response.ok && result.success) {
                        if (emailStatus) {
                            emailStatus.textContent = result.emailSent
                                ? 'Payment verified. Your confirmation email has been sent.'
                                : 'Payment verified. Your confirmation email may be delayed.';
                        }
                    } else {
                        if (emailStatus) {
                            emailStatus.textContent =
                                'Payment verification is pending. Keep your Order ID and contact support if needed.';
                        }
                        console.error('Payment verification needs follow-up:', result);
                    }
                } catch (error) {
                    if (emailStatus) {
                        emailStatus.textContent =
                            'We could not verify the payment right now. Keep your Order ID; please check your order status later.';
                    }
                    console.error('Payment verification request failed:', error);
                } finally {
                    checkoutInProgress = false;
                }
            },

            modal: { ondismiss: function () { checkoutInProgress = false; } }
        };

        const razorpay = new window.Razorpay(options);
        razorpay.on('payment.failed', function (event) {
            checkoutInProgress = false;
            console.error('Razorpay payment failed:', event.error);
            alert(event.error?.description || 'Payment failed. Check your payment status before trying again.');
        });
        razorpay.open();
    } catch (error) {
        checkoutInProgress = false;
        console.error('Checkout failed:', error);
        alert(error.message || 'Checkout failed. Please try again.');
    }
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
