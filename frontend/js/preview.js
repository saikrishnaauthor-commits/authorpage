
const samplePdfByBookId = {
  book_1_pb: 'samples/KaalYug_Shadows_of_Dark_Web_Sample_Chapter.pdf',
  book_2_pb: 'samples/Pages_of_Us_Sample_Chapter.pdf',
  book_3_pb: 'samples/The_Indestructible_Kali_Sample_Chapter.pdf'
};

function openPreview(bookId) {
  const pdfPath = samplePdfByBookId[bookId];

  if (pdfPath) {
    openSamplePreview(bookId);
    return;
  }

  const sample =
    typeof sampleChapters !== 'undefined'
      ? sampleChapters[bookId]
      : null;

  if (!sample) {
    console.error('No sample found for book:', bookId);
    return;
  }

  const title = document.getElementById('preview-title');
  const subtitle = document.getElementById('preview-subtitle');
  const content = document.getElementById('preview-content');
  const modal = document.getElementById('preview-modal');

  if (!title || !subtitle || !content || !modal) return;

  title.textContent = sample.title;
  subtitle.textContent = sample.subtitle;
  content.replaceChildren();
  content.textContent = sample.text;
  content.style.height = '';
  content.style.maxHeight = '';
  modal.classList.remove('hidden');
}

function openSamplePreview(bookId) {
  const pdfPath = samplePdfByBookId[bookId];
  if (!pdfPath) return;

  const book = Array.isArray(catalog)
    ? catalog.find(item => item.pbId === bookId)
    : null;

  const title = document.getElementById('preview-title');
  const subtitle = document.getElementById('preview-subtitle');
  const content = document.getElementById('preview-content');
  const modal = document.getElementById('preview-modal');

  if (!title || !subtitle || !content || !modal) return;

  title.textContent = book?.title || 'Sample Chapter';
  subtitle.textContent = 'Sample Chapter PDF';

  const frame = document.createElement('iframe');
  frame.src = pdfPath;
  frame.title = `${title.textContent} sample chapter`;
  frame.style.cssText = 'display:block;width:100%;height:75vh;min-height:500px;border:0;background:#fff;';

  content.replaceChildren(frame);
  content.style.height = '75vh';
  content.style.maxHeight = '75vh';
  content.style.padding = '0';
  content.style.overflow = 'hidden';

  modal.classList.remove('hidden');
}

function closePreview() {
  const modal = document.getElementById('preview-modal');
  const content = document.getElementById('preview-content');

  if (content) {
    content.replaceChildren();
    content.style.height = '';
    content.style.maxHeight = '';
  }

  modal?.classList.add('hidden');
}
