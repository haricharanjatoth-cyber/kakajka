/* =========================================================
   countries.js — country list + type-to-search dropdown
   Used by auth.js (sign-up "Country" field) via initCountrySearch().
   ========================================================= */

const COUNTRIES = [
  { name: "United States", dial: "+1" }, { name: "United Kingdom", dial: "+44" },
  { name: "Canada", dial: "+1" }, { name: "Australia", dial: "+61" },
  { name: "India", dial: "+91" }, { name: "Germany", dial: "+49" },
  { name: "France", dial: "+33" }, { name: "Spain", dial: "+34" },
  { name: "Italy", dial: "+39" }, { name: "Netherlands", dial: "+31" },
  { name: "Brazil", dial: "+55" }, { name: "Mexico", dial: "+52" },
  { name: "Japan", dial: "+81" }, { name: "South Korea", dial: "+82" },
  { name: "China", dial: "+86" }, { name: "Russia", dial: "+7" },
  { name: "South Africa", dial: "+27" }, { name: "Nigeria", dial: "+234" },
  { name: "Egypt", dial: "+20" }, { name: "Indonesia", dial: "+62" },
  { name: "Philippines", dial: "+63" }, { name: "Vietnam", dial: "+84" },
  { name: "Thailand", dial: "+66" }, { name: "Malaysia", dial: "+60" },
  { name: "Singapore", dial: "+65" }, { name: "Pakistan", dial: "+92" },
  { name: "Bangladesh", dial: "+880" }, { name: "Turkey", dial: "+90" },
  { name: "Saudi Arabia", dial: "+966" }, { name: "United Arab Emirates", dial: "+971" },
  { name: "Israel", dial: "+972" }, { name: "Poland", dial: "+48" },
  { name: "Sweden", dial: "+46" }, { name: "Norway", dial: "+47" },
  { name: "Denmark", dial: "+45" }, { name: "Finland", dial: "+358" },
  { name: "Switzerland", dial: "+41" }, { name: "Austria", dial: "+43" },
  { name: "Belgium", dial: "+32" }, { name: "Portugal", dial: "+351" },
  { name: "Greece", dial: "+30" }, { name: "Ireland", dial: "+353" },
  { name: "New Zealand", dial: "+64" }, { name: "Argentina", dial: "+54" },
  { name: "Chile", dial: "+56" }, { name: "Colombia", dial: "+57" },
  { name: "Peru", dial: "+51" }, { name: "Ukraine", dial: "+380" },
  { name: "Czech Republic", dial: "+420" }, { name: "Romania", dial: "+40" },
  { name: "Hungary", dial: "+36" }, { name: "Portugal", dial: "+351" },
];

// Attaches a type-to-search dropdown to the given text input, listing
// matches from COUNTRIES. Selecting an item sets the input's value to
// the country name. Safe to call more than once per page load (each
// call wires its own listeners on the specific ids passed in).
function initCountrySearch(inputId, dropdownId) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;

  function renderMatches(query) {
    const q = query.trim().toLowerCase();
    const matches = q
      ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
      : COUNTRIES.slice(0, 8);
    if (!matches.length) { dropdown.classList.remove("show"); return; }
    dropdown.innerHTML = matches.map((c) =>
      `<div class="country-search-item" data-name="${c.name}">${c.name} <span style="opacity:.6">(${c.dial})</span></div>`
    ).join("");
    dropdown.classList.add("show");
    dropdown.querySelectorAll(".country-search-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = item.dataset.name;
        dropdown.classList.remove("show");
      });
    });
  }

  input.addEventListener("focus", () => renderMatches(input.value));
  input.addEventListener("input", () => renderMatches(input.value));
  input.addEventListener("blur", () => setTimeout(() => dropdown.classList.remove("show"), 100));
}