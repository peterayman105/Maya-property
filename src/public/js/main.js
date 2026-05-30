const toggleEditBtn = document.getElementById("toggleEdit");
const editPanel = document.getElementById("editPanel");
const editForm = document.getElementById("editForm");
const toggleAddUnitBtn = document.getElementById("toggleAddUnit");
const addUnitForm = document.getElementById("addUnitForm");

if (toggleEditBtn && editPanel) {
  toggleEditBtn.addEventListener("click", () => {
    editPanel.classList.toggle("hidden");
  });
} else if (toggleEditBtn && editForm) {
  toggleEditBtn.addEventListener("click", () => {
    editForm.classList.toggle("hidden");
  });
}

if (toggleAddUnitBtn && addUnitForm) {
  toggleAddUnitBtn.addEventListener("click", () => {
    addUnitForm.classList.toggle("hidden");
  });
}

document.querySelectorAll(".toggle-booking-edit").forEach((button) => {
  button.addEventListener("click", () => {
    const targetId = button.getAttribute("data-target");
    const row = document.getElementById(targetId);
    if (row) row.classList.toggle("hidden");
  });
});

const unitProfitSelect = document.getElementById("unitProfitSelect");
if (unitProfitSelect) {
  unitProfitSelect.addEventListener("change", () => {
    const params = new URLSearchParams(window.location.search);
    const unitId = unitProfitSelect.value;
    if (unitId) params.set("unit", unitId);
    else params.delete("unit");
    window.location.search = params.toString();
  });
}

function initPhotoSliders() {
  document.querySelectorAll("[data-photo-slider]").forEach((root) => {
    const track = root.querySelector(".photo-slider-track");
    const slides = root.querySelectorAll(".photo-slide");
    const prevBtn = root.querySelector(".photo-slider-prev");
    const nextBtn = root.querySelector(".photo-slider-next");
    const dots = root.querySelectorAll(".photo-slider-dot");
    const counter = root.querySelector(".photo-slider-counter");
    if (!track || slides.length <= 1) return;

    let index = 0;
    let touchStartX = 0;

    function render() {
      const offset = index * 100;
      track.style.transform = `translateX(${document.documentElement.dir === "rtl" ? offset : -offset}%)`;
      dots.forEach((dot, i) => dot.classList.toggle("is-active", i === index));
      if (counter) counter.textContent = `${index + 1} / ${slides.length}`;
    }

    function goTo(nextIndex) {
      index = (nextIndex + slides.length) % slides.length;
      render();
    }

    prevBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      goTo(index - 1);
    });

    nextBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      goTo(index + 1);
    });

    dots.forEach((dot) => {
      dot.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        goTo(Number(dot.getAttribute("data-index") || 0));
      });
    });

    root.addEventListener(
      "touchstart",
      (e) => {
        touchStartX = e.changedTouches[0]?.clientX || 0;
      },
      { passive: true }
    );

    root.addEventListener(
      "touchend",
      (e) => {
        const touchEndX = e.changedTouches[0]?.clientX || 0;
        const delta = touchEndX - touchStartX;
        if (Math.abs(delta) < 40) return;
        if (delta < 0) goTo(index + 1);
        else goTo(index - 1);
      },
      { passive: true }
    );

    render();
  });
}

initPhotoSliders();
