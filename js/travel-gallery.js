
const slidesContainer = document.getElementById("travel-slides");
const previousButton = document.getElementById("travel-prev");
const nextButton = document.getElementById("travel-next");
const playButton = document.getElementById("travel-play");
const counter = document.getElementById("travel-counter");
const dotsContainer = document.getElementById("travel-dots");

let photos = [];
let currentIndex = 0;
let timer = null;
let playing = true;

async function loadTravelPhotos() {
  try {
    const response = await fetch("./travel-photos.json", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Could not load travel-photos.json: HTTP ${response.status}`
      );
    }

    const list = await response.json();

    if (!Array.isArray(list)) {
      throw new Error("travel-photos.json must contain a JSON array.");
    }

    // Check which image files actually exist.
    const results = await Promise.all(
      list
        .filter(path => typeof path === "string" && path.trim())
        .map(async path => {
          const imagePath = path.trim();

          try {
            const imageResponse = await fetch(imagePath, {
              method: "HEAD"
            });

            return imageResponse.ok ? imagePath : null;
          } catch {
            return null;
          }
        })
    );

    photos = results.filter(Boolean);

    if (photos.length === 0) {
      throw new Error(
        "No photos could be found. Check the filenames in travel-photos.json."
      );
    }

    slidesContainer.innerHTML = "";
    dotsContainer.innerHTML = "";

    photos.forEach((path, index) => {
      const image = document.createElement("img");
      image.src = path;
      image.alt = `Travel memory ${index + 1}`;
      image.className =
        "w-full h-[260px] sm:h-[400px] md:h-[540px] object-contain bg-slate-900";
      image.hidden = true;
      image.loading = index === 0 ? "eager" : "lazy";

      slidesContainer.appendChild(image);

      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "w-3 h-3 rounded-full bg-gray-300";
      dot.setAttribute("aria-label", `Show photo ${index + 1}`);
      dot.addEventListener("click", () => {
        showPhoto(index);
        startSlideshow();
      });

      dotsContainer.appendChild(dot);
    });

    showPhoto(0);

    previousButton.hidden = photos.length < 2;
    nextButton.hidden = photos.length < 2;
    playButton.hidden = photos.length < 2;

    if (photos.length > 1) {
      startSlideshow();
    }
  } catch (error) {
    console.error("Travel slideshow error:", error);

    slidesContainer.innerHTML = `
      <div class="p-10 text-center text-gray-700">
        <p class="font-semibold">Travel photos could not be loaded.</p>
        <p class="mt-2 text-sm">${error.message}</p>
      </div>
    `;

    previousButton.hidden = true;
    nextButton.hidden = true;
    playButton.hidden = true;
  }
}

function showPhoto(index) {
  if (!photos.length) return;

  currentIndex = (index + photos.length) % photos.length;

  slidesContainer.querySelectorAll("img").forEach((image, i) => {
    image.hidden = i !== currentIndex;
  });

  dotsContainer.querySelectorAll("button").forEach((dot, i) => {
    dot.classList.toggle("bg-indigo-600", i === currentIndex);
    dot.classList.toggle("bg-gray-300", i !== currentIndex);
  });

  counter.textContent = `Photo ${currentIndex + 1} of ${photos.length}`;
}

function startSlideshow() {
  stopSlideshow();

  if (!playing || photos.length < 2) return;

  timer = setInterval(() => {
    showPhoto(currentIndex + 1);
  }, 4000);
}

function stopSlideshow() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

previousButton.addEventListener("click", () => {
  showPhoto(currentIndex - 1);
  startSlideshow();
});

nextButton.addEventListener("click", () => {
  showPhoto(currentIndex + 1);
  startSlideshow();
});

playButton.addEventListener("click", () => {
  playing = !playing;
  playButton.textContent = playing
    ? "Pause slideshow"
    : "Play slideshow";

  if (playing) {
    startSlideshow();
  } else {
    stopSlideshow();
  }
});

loadTravelPhotos();
