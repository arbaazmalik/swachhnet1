const mongoose = require('mongoose');

/**
 * Resolves ward scope based on user role and optional requested ward ID.
 * Rules:
 * - Authority: MUST have a valid wardId. If missing -> 403 Forbidden.
 *   If requested ward ID is given and doesn't match authority's wardId -> 403 Forbidden.
 *   Otherwise returns { wardId: ownWardId }.
 * - Admin: Can access requested ward ID if valid, or unrestricted system-wide if unsupplied.
 *   Returns { wardId: requestedWardId || undefined }.
 * - Others: Returns 403 Forbidden.
 */
function resolveWardScope(req, requestedWardId) {
  if (requestedWardId && !mongoose.isValidObjectId(requestedWardId)) {
    return { error: { status: 400, message: 'Invalid ward_id' } };
  }

  const role = req.user?.role;
  const ownWardId = req.user?.wardId ? String(req.user.wardId) : null;

  if (role === 'authority') {
    if (!ownWardId) {
      return { error: { status: 403, message: 'Authority account is not assigned to a ward.' } };
    }
    if (requestedWardId && String(requestedWardId) !== ownWardId) {
      return { error: { status: 403, message: 'Authority users can only access their assigned ward' } };
    }
    return { wardId: ownWardId };
  }

  if (role === 'admin') {
    return { wardId: requestedWardId ? String(requestedWardId) : undefined };
  }

  return { error: { status: 403, message: 'Insufficient permissions' } };
}

module.exports = { resolveWardScope };
