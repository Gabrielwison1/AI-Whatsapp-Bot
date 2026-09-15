const pharmacies = [
  {
    id: "medplus-utako",
    name: "MedPlus Utako",
    state: "FCT",
    city: "Abuja",
    phone: "+2348000000001",
    active: true,
  },
  {
    id: "healthplus-ikeja",
    name: "HealthPlus Ikeja",
    state: "Lagos",
    city: "Lagos",
    phone: "+2348000000002",
    active: true,
  },
  {
    id: "alpha-pharmacy-ph",
    name: "Alpha Pharmacy PH",
    state: "Rivers",
    city: "Port Harcourt",
    phone: "+2348000000003",
    active: true,
  },
];

export function findPharmacyByState(state) {
  if (!state) return null;
  const normalized = state.trim().toLowerCase();
  return (
    pharmacies.find(
      (p) =>
        p.active &&
        (p.state.toLowerCase() === normalized ||
        p.city.toLowerCase() === normalized)
    ) || null
  );
}

export function getAllPharmacies() {
  return pharmacies;
}

export default pharmacies;
