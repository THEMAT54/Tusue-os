/*
  ==========================================================
  CONFIGURACIÓN DE FIREBASE - Tu Sueños
  ==========================================================
  Proyecto: tusuenoscolchones
  Pendiente:
    1. Activar en el panel de Firebase:
       - Authentication -> Sign-in method -> Correo/contraseña
       - Firestore Database -> Crear base de datos (modo producción)
    2. Subir las reglas de seguridad (archivo firestore.rules) desde
       Firestore Database -> Reglas, pegando su contenido y publicando.
    3. Crear los 5 usuarios (admin + 4 locales) según SETUP.md.
  ==========================================================
*/

const firebaseConfig = {
  apiKey: "AIzaSyDn7qYymsn3Rd7F3UkL0xNaotQNbbCrwUw",
  authDomain: "tusuenoscolchones.firebaseapp.com",
  projectId: "tusuenoscolchones",
  storageBucket: "tusuenoscolchones.firebasestorage.app",
  messagingSenderId: "286720480102",
  appId: "1:286720480102:web:162a56256e4be40cc0aea7"
  // databaseURL y measurementId no se incluyen: no usamos Realtime Database
  // ni Google Analytics en esta app (solo Firestore + Authentication).
};

// Inicializa Firebase (usa la API "compat" para simplicidad en JS vanilla)
firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// Nombres de los 4 locales. Cambiar acá si querés renombrarlos.
const LOCALES = {
  local1: "Local 1",
  local2: "Local 2",
  local3: "Local 3",
  local4: "Local 4"
};
