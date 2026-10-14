// Initialize after all classic scripts have loaded.
document.addEventListener('DOMContentLoaded', function () {
  cart = loadCart();
  fetchBooks();
  updateCartUI();
});
