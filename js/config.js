/* ==========================================================================
   Configuracion de conexion a Supabase.
   Reemplaza estos dos valores con los de tu proyecto:
   Supabase -> Project Settings -> API -> "Project URL" y "anon public" key.
   ========================================================================== */
window.SUPABASE_URL = "https://ozvpfwuzgepnszsjhxxx.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96dnBmd3V6Z2VwbnN6c2poeHh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NDM3MDEsImV4cCI6MjEwNTIxOTcwMX0.6Cuh2JdoFW3PbL5lYLo9cuSPgf32RtCTdxUcPZvksSQ";

/* Clave simple para que no cualquiera que encuentre el link entre a escribir datos.
   Esto NO es seguridad real (cualquiera que vea el codigo de la pagina puede
   encontrarla), solo un freno basico. Cambiala por la que quieras.
   Hay dos claves: una de edicion (puede registrar/editar/eliminar) y una de
   solo consulta (puede ver todo pero no puede guardar ni borrar nada). */
window.APP_PASSWORD = "OR2026";
window.APP_PASSWORD_VIEW = "0000";
