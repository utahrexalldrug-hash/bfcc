import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAKnJO89fSQKr7kuaKhkxtc15BFNqpLDtQ",
  authDomain: "family-hq-c133c.firebaseapp.com",
  projectId: "family-hq-c133c",
  storageBucket: "family-hq-c133c.firebasestorage.app",
  messagingSenderId: "59125881260",
  appId: "1:59125881260:web:615713de1add487fbb0209"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
