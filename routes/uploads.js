const express = require('express');
const multer = require('multer');
const supabaseStorage = require('../services/supabaseStorage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ALLOWED_FOLDERS = new Set(['avatars', 'logos', 'payments']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

// Generic image upload, used for team logos, user avatars and payment
// proof screenshots. `folder` (query param) just groups files in the
// bucket for browsing — it grants no extra access on its own.
router.post('/', authenticate, upload.single('file'), async (req, res) => {
  if (!supabaseStorage.isConfigured()) {
    return res.status(503).json({
      error: "Stockage d'images pas encore configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants dans backend/.env).",
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu (champ "file" attendu, image jpeg/png/webp/gif, 5MB max).' });
  }
  const folder = ALLOWED_FOLDERS.has(req.query.folder) ? req.query.folder : 'misc';

  try {
    const url = await supabaseStorage.uploadImage({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalName: req.file.originalname,
      folder,
    });
    res.status(201).json({ url });
  } catch (err) {
    res.status(502).json({ error: err.message || "Échec de l'upload." });
  }
});

module.exports = router;
