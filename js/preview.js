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

function openPreview(pdfPath, title, subtitle) {
  const modal = document.getElementById('preview-modal');
  const titleElement = document.getElementById('preview-title');
  const subtitleElement = document.getElementById('preview-subtitle');
  const content = document.getElementById('preview-content');

  if (!modal || !titleElement || !subtitleElement || !content) return;

  titleElement.textContent = title;
  subtitleElement.textContent = subtitle;
  content.replaceChildren();

  const frame = document.createElement('iframe');
  frame.src = pdfPath;
  frame.title = `${title} sample chapter`;
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.minHeight = '0';
  frame.style.border = '0';
  frame.style.display = 'block';
  frame.style.border = '0';

  content.appendChild(frame);
  modal.classList.remove('hidden');
}

function closePreview() {
    const modal = document.getElementById("preview-modal");
    const content = document.getElementById("preview-content");

    if (modal) modal.classList.add("hidden");
    if (content) content.replaceChildren();
}
