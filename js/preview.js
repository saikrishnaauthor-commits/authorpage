// Modularized from the working cart.js; function bodies preserved.

function openPreview(bookId) {
  const sample = sampleChapters[bookId];

  if (!sample) return;

  const title = document.getElementById('preview-title');
  const subtitle = document.getElementById('preview-subtitle');
  const content = document.getElementById('preview-content');
  const modal = document.getElementById('preview-modal');

  if (!title || !subtitle || !content || !modal) return;

  title.textContent = sample.title;
  subtitle.textContent = sample.subtitle;
  content.textContent = sample.text;
  modal.classList.remove('hidden');
}

function closePreview() {
  document.getElementById('preview-modal')
    ?.classList.add('hidden');
}
