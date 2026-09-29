// Firebase web config — shared by the app (src/firebase.js) and the reminder
// sender (api/remind.js). These values are public by design (they ship in the
// page); access is governed by Firestore rules, not by keeping them secret.
export const firebaseConfig = {
  apiKey: "AIzaSyAKnJO89fSQKr7kuaKhkxtc15BFNqpLDtQ",
  authDomain: "family-hq-c133c.firebaseapp.com",
  projectId: "family-hq-c133c",
  storageBucket: "family-hq-c133c.firebasestorage.app",
  messagingSenderId: "59125881260",
  appId: "1:59125881260:web:615713de1add487fbb0209"
};
