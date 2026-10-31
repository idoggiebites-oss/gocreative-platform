-- Deterministic, fictional dev data. Re-runnable: wipes child tables first.
-- activity_log is append-only via trigger, so the trigger is dropped around its
-- DELETE and recreated identically to migrations/0001_init.sql.
DROP TRIGGER IF EXISTS activity_log_no_delete;
DELETE FROM activity_log;
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
DELETE FROM notes;
DELETE FROM artwork;
DELETE FROM po_documents;
DELETE FROM files;
DELETE FROM purchase_orders;
DELETE FROM estimates;
DELETE FROM order_items;
DELETE FROM inquiries;
DELETE FROM orders;
DELETE FROM customer_contacts;
DELETE FROM customers;
DELETE FROM users;
DELETE FROM counters;


INSERT INTO users (id, email, name, role) VALUES
  (1, 'owner1@example.com', 'Owner One', 'owner'),
  (2, 'owner2@example.com', 'Owner Two', 'owner');

INSERT INTO customers (id, kind, name, email, phone) VALUES
  (1, 'district', 'Riverbend Unified School District', 'contact1@example.com', '555-0101'),
  (2, 'district', 'Cedar Hollow ISD', 'contact2@example.com', '555-0102'),
  (3, 'district', 'Maple Ridge School District', 'contact3@example.com', '555-0103'),
  (4, 'organization', 'Harbor Light Youth Soccer Club', 'contact4@example.com', '555-0104'),
  (5, 'organization', 'Lantern Street Bakery', 'contact5@example.com', '555-0105'),
  (6, 'individual', 'Dana Whitfield', 'contact6@example.com', '555-0106'),
  (7, 'individual', 'Marcus Oyelaran', 'contact7@example.com', '555-0107'),
  (8, 'individual', 'Priya Nandakumar', 'contact8@example.com', '555-0108');

INSERT INTO customer_contacts (id, customer_id, name, email, phone, title, is_primary) VALUES
  (1, 1, 'Helen Marsh', 'person1@example.com', '555-0201', 'Athletics Director', 1),
  (2, 1, 'Tom Eddings', 'person2@example.com', '555-0202', 'Front Office', 0),
  (3, 2, 'Rosa Delgado', 'person3@example.com', '555-0203', 'Band Director', 1),
  (4, 2, 'Ken Albright', 'person4@example.com', '555-0204', 'Purchasing', 0),
  (5, 3, 'Joan Pruitt', 'person5@example.com', '555-0205', 'PTA Liaison', 1),
  (6, 3, 'Sam Okafor', 'person6@example.com', '555-0206', 'Purchasing', 0),
  (7, 4, 'Lee Carver', 'person7@example.com', '555-0207', 'Club Manager', 1),
  (8, 5, 'Mina Park', 'person8@example.com', '555-0208', 'Owner', 0);

INSERT INTO orders (id, number, customer_id, contact_id, source, title, due_date, artwork_status, po_required, authorized_at, authorized_by, production_status, assignee_id, estimated_total_cents, state, created_by) VALUES
  (1, '2026-0001', 1, 1, 'phone', 'Varsity hoodies', date('now', '-20 days'), 'approved', 1, NULL, NULL, 'completed', 2, 156600, 'completed', 2),
  (2, '2026-0002', 1, 2, 'email', 'Front office polos', date('now', '-10 days'), 'approved', 1, NULL, NULL, 'completed', 1, 230300, 'completed', 1),
  (3, '2026-0003', 2, 3, 'portal', 'Marching band shirts', date('now', '-3 days'), 'approved', 1, NULL, NULL, 'in_production', 2, 18000, 'active', 2),
  (4, '2026-0004', 2, 4, 'email', 'Staff appreciation caps', date('now', '+2 days'), 'approved', 1, NULL, NULL, 'quality_control', 1, 73000, 'active', 1),
  (5, '2026-0005', 3, 5, 'phone', 'PTA spirit wear', date('now', '+5 days'), 'approved', 1, NULL, NULL, 'ready', 2, 186000, 'active', 2),
  (6, '2026-0006', 3, 6, 'portal', 'Fun run tees', date('now', '+1 days'), 'approved', 1, NULL, NULL, 'ready_for_pickup', 1, 72000, 'active', 1),
  (7, '2026-0007', 1, 1, 'email', 'Cross country jackets', date('now', '+9 days'), 'pending', 1, NULL, NULL, 'awaiting_artwork', 2, 156600, 'active', 2),
  (8, '2026-0008', 2, 3, 'phone', 'Library tote bags', date('now', '+14 days'), 'none', 1, NULL, NULL, 'awaiting_artwork', 1, 230300, 'active', 1),
  (9, '2026-0009', 3, 5, 'portal', 'Choir shirts', date('now', '+6 days'), 'changes_requested', 1, NULL, NULL, 'awaiting_artwork', 2, 18000, 'active', 2),
  (10, '2026-0010', 1, 2, 'email', 'Robotics team hoodies', date('now', '+12 days'), 'approved', 1, NULL, NULL, 'awaiting_authorization', 1, 73000, 'active', 1),
  (11, '2026-0011', 2, 4, 'phone', 'Track team shirts', date('now', '+4 days'), 'approved', 1, NULL, NULL, 'awaiting_authorization', 2, 186000, 'active', 2),
  (12, '2026-0012', 3, 6, 'email', 'Teacher lanyards and mugs', date('now', '+20 days'), 'pending', 1, NULL, NULL, 'awaiting_authorization', 1, 72000, 'active', 1),
  (13, '2026-0013', 1, 1, 'portal', 'Graduation stoles', date('now', '-2 days'), 'approved', 1, NULL, NULL, 'awaiting_authorization', 2, 156600, 'active', 2),
  (14, '2026-0014', 2, 3, 'phone', 'Drama club hats', date('now', '+30 days'), 'none', 1, NULL, NULL, 'awaiting_authorization', 1, 230300, 'active', 1),
  (15, '2026-0015', 4, 7, 'phone', 'Season jerseys', date('now', '-15 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'completed', 2, 18000, 'completed', 2),
  (16, '2026-0016', 4, 7, 'email', 'Coach polos', date('now', '+3 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'in_production', 1, 73000, 'active', 1),
  (17, '2026-0017', 5, 8, 'portal', 'Staff aprons', date('now', '-1 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'ready', 2, 186000, 'active', 2),
  (18, '2026-0018', 5, 8, 'phone', 'Cutting boards', date('now', '+10 days'), 'pending', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'awaiting_artwork', 1, 72000, 'active', 1),
  (19, '2026-0019', 6, NULL, 'email', 'Family reunion tees', date('now', '+7 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'quality_control', 2, 156600, 'active', 2),
  (20, '2026-0020', 6, NULL, 'portal', 'Engraved tumbler', date('now', '+0 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'ready_for_pickup', 1, 230300, 'active', 1),
  (21, '2026-0021', 7, NULL, 'phone', 'Wedding favors', date('now', '+16 days'), 'approved', 0, NULL, NULL, 'awaiting_authorization', 2, 18000, 'active', 2),
  (22, '2026-0022', 7, NULL, 'phone', 'Memorial plaque', date('now', '+25 days'), 'none', 0, NULL, NULL, 'awaiting_authorization', 1, 73000, 'active', 1),
  (23, '2026-0023', 8, NULL, 'email', 'Hockey bags', date('now', '+45 days'), 'approved', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'in_production', 2, 186000, 'active', 2),
  (24, '2026-0024', 8, NULL, 'portal', 'Birthday hoodies', date('now', '+8 days'), 'changes_requested', 0, NULL, NULL, 'awaiting_authorization', 1, 72000, 'cancelled', 1);

INSERT INTO order_items (id, order_id, product, garment_color, method, sizes, quantity, unit_price_cents, notes) VALUES
  (1, 1, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (2, 1, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (3, 2, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (4, 2, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (5, 2, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (6, 3, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (7, 4, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (8, 4, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (9, 5, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (10, 5, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (11, 5, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (12, 6, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (13, 7, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (14, 7, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (15, 8, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (16, 8, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (17, 8, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (18, 9, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (19, 10, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (20, 10, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (21, 11, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (22, 11, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (23, 11, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (24, 12, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (25, 13, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (26, 13, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (27, 14, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (28, 14, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (29, 14, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (30, 15, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (31, 16, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (32, 16, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (33, 17, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (34, 17, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (35, 17, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (36, 18, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (37, 19, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (38, 19, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (39, 20, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (40, 20, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (41, 20, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (42, 21, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (43, 22, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (44, 22, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (45, 23, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (46, 23, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (47, 23, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (48, 24, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL);

INSERT INTO estimates (id, order_id, version, inputs, lines, total_cents, status) VALUES
  (1, 2, 1, '{"markup":0.3}', '[{"label":"Order total","cents":230300}]', 230300, 'draft'),
  (2, 4, 1, '{"markup":0.3}', '[{"label":"Order total","cents":73000}]', 73000, 'sent'),
  (3, 6, 1, '{"markup":0.3}', '[{"label":"Order total","cents":72000}]', 72000, 'accepted'),
  (4, 8, 1, '{"markup":0.3}', '[{"label":"Order total","cents":230300}]', 230300, 'declined'),
  (5, 10, 1, '{"markup":0.3}', '[{"label":"Order total","cents":73000}]', 73000, 'draft'),
  (6, 12, 1, '{"markup":0.3}', '[{"label":"Order total","cents":72000}]', 72000, 'sent'),
  (7, 14, 1, '{"markup":0.3}', '[{"label":"Order total","cents":230300}]', 230300, 'accepted'),
  (8, 16, 1, '{"markup":0.3}', '[{"label":"Order total","cents":73000}]', 73000, 'declined'),
  (9, 18, 1, '{"markup":0.3}', '[{"label":"Order total","cents":72000}]', 72000, 'draft'),
  (10, 20, 1, '{"markup":0.3}', '[{"label":"Order total","cents":230300}]', 230300, 'sent'),
  (11, 22, 1, '{"markup":0.3}', '[{"label":"Order total","cents":73000}]', 73000, 'accepted'),
  (12, 24, 1, '{"markup":0.3}', '[{"label":"Order total","cents":72000}]', 72000, 'declined');

INSERT INTO purchase_orders (id, order_id, po_number, amount_cents, status) VALUES
  (1, 1, 'PO-2026-10', 156600, 'approved'),
  (2, 2, 'PO-2026-20', 230300, 'approved'),
  (3, 3, 'PO-2026-30', 18000, 'approved'),
  (4, 4, 'PO-2026-40', 73000, 'rejected'),
  (5, 4, 'PO-2026-41', 73000, 'approved'),
  (6, 5, 'PO-2026-50', 186000, 'approved'),
  (7, 6, 'PO-2026-60', 72000, 'approved'),
  (8, 7, 'PO-2026-70', 156600, 'approved'),
  (9, 8, 'PO-2026-80', 230300, 'approved'),
  (10, 9, 'PO-2026-90', 18000, 'approved'),
  (11, 10, 'PO-2026-100', 73000, 'requested'),
  (12, 11, 'PO-2026-110', 186000, 'received'),
  (13, 12, 'PO-2026-120', 72000, 'under_review'),
  (14, 13, 'PO-2026-130', 156600, 'rejected'),
  (15, 14, 'PO-2026-140', 230300, 'correction_required');

INSERT INTO notes (id, entity_type, entity_id, author_id, body) VALUES
  (1, 'order', 3, 2, 'Customer prefers pickup after 3pm.'),
  (2, 'order', 6, 1, 'Customer prefers pickup after 3pm.'),
  (3, 'order', 9, 2, 'Customer prefers pickup after 3pm.'),
  (4, 'order', 12, 1, 'Customer prefers pickup after 3pm.'),
  (5, 'order', 15, 2, 'Customer prefers pickup after 3pm.'),
  (6, 'order', 18, 1, 'Customer prefers pickup after 3pm.'),
  (7, 'order', 21, 2, 'Customer prefers pickup after 3pm.'),
  (8, 'order', 24, 1, 'Customer prefers pickup after 3pm.'),
  (9, 'customer', 1, 1, 'Always needs a PO before work starts.');

INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after) VALUES
  ('user', 2, 'order', 1, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 1, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"completed"}'),
  ('user', 1, 'order', 2, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 2, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"completed"}'),
  ('user', 2, 'order', 3, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 3, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"in_production"}'),
  ('user', 1, 'order', 4, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 4, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"quality_control"}'),
  ('user', 2, 'order', 5, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 5, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"ready"}'),
  ('user', 1, 'order', 6, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 6, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"ready_for_pickup"}'),
  ('user', 2, 'order', 7, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 7, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 1, 'order', 8, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 8, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 2, 'order', 9, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 9, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 1, 'order', 10, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 11, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 12, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 13, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 14, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 15, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 15, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"completed"}'),
  ('user', 1, 'order', 16, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 16, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"in_production"}'),
  ('user', 2, 'order', 17, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 17, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"ready"}'),
  ('user', 1, 'order', 18, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 18, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 2, 'order', 19, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 19, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"quality_control"}'),
  ('user', 1, 'order', 20, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 20, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"ready_for_pickup"}'),
  ('user', 2, 'order', 21, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 22, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 23, 'created', NULL, '{"production_status":"awaiting_authorization"}'),
  ('user', 2, 'order', 23, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"in_production"}'),
  ('user', 1, 'order', 24, 'created', NULL, '{"production_status":"awaiting_authorization"}');

-- Backdate part of the data so the dashboard sub-lines ("new this week", "waiting 5+ days") have something to say.
UPDATE orders SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') WHERE id <= 12;
UPDATE estimates SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE id = 2;
UPDATE estimates SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days') WHERE id = 6;

INSERT INTO counters (name, year, next) VALUES ('order', 2026, 25);
