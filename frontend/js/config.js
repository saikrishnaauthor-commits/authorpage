// Shared state and preview content. Keep these declarations in one file only.
'use strict';

// Sai Krishna Author Store — cart, catalogue, preview and Razorpay checkout.
// Keep this file alongside index.html and catalog.json.

const API_URL = 'https://authorpage-gybu.onrender.com';
const CART_STORAGE_KEY = 'authorStoreCart';

let catalog = [];
let cart = [];
let checkoutInProgress = false;

const sampleChapters = {
  book_1_pb: {
    title: 'KaalYug',
    subtitle: 'Sample Chapter Preview',
    text: 'The winds of transition whispered through the ancient pillars. Time was never a straight line, but a wheel turning endlessly through eras of light and shadow...'
  },
  book_1_eb: {
    title: 'KaalYug',
    subtitle: 'Sample Chapter Preview',
    text: 'The winds of transition whispered through the ancient pillars. Time was never a straight line, but a wheel turning endlessly through eras of light and shadow...'
  },
  book_2_pb: {
    title: 'Pages of Us',
    subtitle: 'Sample Chapter Preview',
    text: 'Some memories are folded like dried flowers between the pages of an old diary. When opened, they release a fragrance of nostalgia that defies distance and years...'
  },
  book_2_eb: {
    title: 'Pages of Us',
    subtitle: 'Sample Chapter Preview',
    text: 'Some memories are folded like dried flowers between the pages of an old diary. When opened, they release a fragrance of nostalgia that defies distance and years...'
  },
  book_3_pb: {
    title: 'The Indestructible Kali',
    subtitle: 'Sample Chapter Preview',
    text: 'Beyond the veil of ordinary perception lies the primal energy that sustains and transforms the cosmos. Unbound by time or form, this force represents ultimate resilience...'
  },
  book_3_eb: {
    title: 'The Indestructible Kali',
    subtitle: 'Sample Chapter Preview',
    text: 'Beyond the veil of ordinary perception lies the primal energy that sustains and transforms the cosmos. Unbound by time or form, this force represents ultimate resilience...'
  }
};
