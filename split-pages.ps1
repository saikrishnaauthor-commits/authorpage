
$ErrorActionPreference = 'Stop'

$source = Get-Content .\index.html -Raw

function Get-Section([string]$start, [string]$end) {
    $a = $source.IndexOf($start)
    if ($a -lt 0) { throw "Start marker not found: $start" }

    $b = $source.IndexOf($end, $a)
    if ($b -lt 0) { throw "End marker not found: $end" }

    return $source.Substring($a, $b - $a)
}

function New-Page([string]$file, [string]$title, [string]$content, [string]$scripts) {
    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>$title</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800 font-sans">
<header class="bg-white shadow-sm sticky top-0 z-40">
<div class="max-w-6xl mx-auto px-4 py-4 flex flex-wrap justify-between items-center gap-4">
<a href="index.html" class="text-2xl font-bold text-indigo-700">Sai Krishna | Author</a>
<nav class="flex flex-wrap gap-4 font-medium text-gray-600">
<a href="index.html">Home</a>
<a href="books.html">Books</a>
<a href="about.html">About Author</a>
<a href="reviews.html">Reviews</a>
<a href="ebooks.html">My E-books</a>
<a href="order-status.html">Order Status</a>
</nav>
</div>
</header>
$content
$scripts
</body>
</html>
"@

    Set-Content -Path $file -Value $html -Encoding UTF8
    Write-Host "Created $file"
}

# Extract existing content without modifying the homepage.
$books = Get-Section '<!-- Books Section -->' '<!-- About Author Section -->'
$about = Get-Section '<!-- About Author Section -->' '<!-- Reader Reviews Section -->'
$reviews = Get-Section '<!-- Reader Reviews Section -->' '<footer'
$ebooks = Get-Section '<section id="my-ebooks"' '<!-- Customer Order Status Lookup -->'
$orderStatus = Get-Section '<!-- Customer Order Status Lookup -->' '<!-- Sample Chapter Modal -->'
$previewAndCart = Get-Section '<!-- Sample Chapter Modal -->' '<!-- External Cart & Store Logic Script -->'

# Book catalogue, preview, cart and checkout.
$bookScripts = @'
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script src="js/config.js"></script>
<script src="js/catalog.js"></script>
<script src="js/preview.js"></script>
<script src="js/cart.js"></script>
<script src="js/checkout.js"></script>
<script src="js/order-status.js"></script>
<script src="js/app.js"></script>
'@

$ebookScripts = @'
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="js/ebooks.js"></script>
'@

$orderScripts = @'
<script src="js/order-status.js"></script>
'@

New-Page 'books.html' 'Books | Sai Krishna Author Store' ($books + $previewAndCart) $bookScripts
New-Page 'about.html' 'About the Author | Sai Krishna' $about ''
New-Page 'reviews.html' 'Reader Reviews | Sai Krishna' $reviews ''
New-Page 'ebooks.html' 'My E-books | Sai Krishna Author Store' $ebooks $ebookScripts
New-Page 'order-status.html' 'Order Status | Sai Krishna Author Store' $orderStatus $orderScripts

Write-Host ''
Write-Host 'Created five new pages. The existing homepage and admin page were not overwritten.'
