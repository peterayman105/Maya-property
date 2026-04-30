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
