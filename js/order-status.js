// Customer-facing order status helpers. Payment verification runs separately.

function showOrderPending(orderNumber) {
    const modal = document.getElementById('order-success-modal');

    if (!modal) {
        alert('Your Order ID: ' + (orderNumber || 'Please contact support.'));
        return;
    }

    const title = document.getElementById('order-modal-title');
    const messageElement = document.getElementById('order-modal-message');
    const spinner = document.getElementById('order-pending-spinner');
    const orderId = document.getElementById('confirmed-order-id');
    const copyStatus = document.getElementById('copy-order-status');
    const emailStatus = document.getElementById('confirmation-email-status');

    if (title) title.textContent = 'Your Order ID';

    if (messageElement) {
        messageElement.textContent = 'Please save your Order ID for future reference.';
    }

    if (orderId) {
        orderId.textContent = orderNumber || 'Order ID unavailable. Please contact support.';
    }

    spinner?.classList.add('hidden');

    if (copyStatus) copyStatus.textContent = '';
    if (emailStatus) emailStatus.textContent = '';

    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function showOrderSuccess(orderNumber, emailSent) {
  const title = document.getElementById('order-modal-title');
  const message = document.getElementById('order-modal-message');
  const spinner = document.getElementById('order-pending-spinner');
  const orderId = document.getElementById('confirmed-order-id');
  const copyStatus = document.getElementById('copy-order-status');
  const emailStatus = document.getElementById('confirmation-email-status');
  const modal = document.getElementById('order-success-modal');

  if (title) title.textContent = 'Thank you for your order!';
  if (message) message.textContent = 'Your order number is ready. You do not need to wait on this page. Payment verification is processed securely in the background.';
  if (spinner) spinner.classList.add('hidden');
  if (orderId) orderId.textContent = orderNumber || '';
  if (copyStatus) copyStatus.textContent = '';
  if (emailStatus) emailStatus.textContent = emailSent ? 'Your confirmation email has been sent.' : 'You can close this window; email delivery may take a little longer.';
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

async function copyOrderId() {
  const orderNumber = document.getElementById('confirmed-order-id')?.textContent || '';
  const status = document.getElementById('copy-order-status');
  if (!orderNumber) return;
  try {
    await navigator.clipboard.writeText(orderNumber);
    if (status) status.textContent = 'Order ID copied successfully!';
  } catch {
    if (status) status.textContent = 'Please select and copy the Order ID manually.';
  }
}

function closeOrderSuccess() {
  const modal = document.getElementById('order-success-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}
