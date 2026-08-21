// middleware/auth.js
function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Admin access required' });
}

function ensureStudent(req, res, next) {
  if (req.session.user && req.session.user.role === 'student') {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Student login required' });
}

function ensureParent(req, res, next) {
  if (req.session.user && req.session.user.role === 'parent') {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Parent login required' });
}

module.exports = { ensureAdmin, ensureStudent, ensureParent };
