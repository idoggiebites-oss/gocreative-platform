-- Deterministic, fictional dev data for the Phase 2 schema (migrations 0001 … 0006). Re-runnable: wipes
-- child tables first. activity_log, purchase receipts, pickups, check collections and payments are never deleted and
-- frozen quotes can't be deleted, so those delete
-- triggers are dropped around the wipe and recreated identically to the migrations
-- (tests/api/seed.test.ts fails if they drift).
-- Every order's production_status is what readiness() derives, or a later stage reached with every
-- prerequisite met (tests/api/seed.test.ts checks this too).
DROP TRIGGER IF EXISTS activity_log_no_delete;
DROP TRIGGER IF EXISTS quote_items_delete_draft_only;
DROP TRIGGER IF EXISTS quotes_delete_draft_only;
DROP TRIGGER IF EXISTS purchase_receipts_no_delete;
DROP TRIGGER IF EXISTS order_purchases_no_delete;
DROP TRIGGER IF EXISTS pickups_no_delete;
DROP TRIGGER IF EXISTS check_collections_no_delete;
DROP TRIGGER IF EXISTS payments_no_delete;
DROP TRIGGER IF EXISTS payments_linked_no_delete;
DELETE FROM payments;
DELETE FROM check_collections;
DELETE FROM pickups;
CREATE TRIGGER pickups_no_delete BEFORE DELETE ON pickups
BEGIN SELECT RAISE(ABORT, 'pickups are never deleted'); END;
CREATE TRIGGER check_collections_no_delete BEFORE DELETE ON check_collections
BEGIN SELECT RAISE(ABORT, 'check collections are never deleted'); END;
CREATE TRIGGER payments_linked_no_delete BEFORE DELETE ON payments
WHEN OLD.check_collection_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'payment_linked_to_check');
END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
WHEN OLD.check_collection_id IS NULL
BEGIN SELECT RAISE(ABORT, 'payments are never deleted'); END;
DELETE FROM activity_log;
DELETE FROM purchase_receipts;
DELETE FROM order_purchases;
DELETE FROM quote_items;
DELETE FROM quotes;
CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;
CREATE TRIGGER quote_items_delete_draft_only BEFORE DELETE ON quote_items
WHEN (SELECT status FROM quotes WHERE id = OLD.quote_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
CREATE TRIGGER quotes_delete_draft_only BEFORE DELETE ON quotes
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'quote_not_draft'); END;
CREATE TRIGGER purchase_receipts_no_delete BEFORE DELETE ON purchase_receipts
BEGIN SELECT RAISE(ABORT, 'purchase_receipts are write-once'); END;
CREATE TRIGGER order_purchases_no_delete BEFORE DELETE ON order_purchases
BEGIN SELECT RAISE(ABORT, 'order_purchases are never deleted'); END;
DELETE FROM notes;
DELETE FROM artwork;
DELETE FROM po_documents;
DELETE FROM files;
DELETE FROM purchase_orders;
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

-- Districts pay by check after pickup and need a PO; the others pay at pickup with direct authorization.
INSERT INTO customers (id, kind, name, email, phone, default_po_required, default_payment_terms) VALUES
  (1, 'district', 'Riverbend Unified School District', 'contact1@example.com', '555-0101', 1, 'due_after_pickup'),
  (2, 'district', 'Cedar Hollow ISD', 'contact2@example.com', '555-0102', 1, 'due_after_pickup'),
  (3, 'district', 'Maple Ridge School District', 'contact3@example.com', '555-0103', 1, 'due_after_pickup'),
  (4, 'organization', 'Harbor Light Youth Soccer Club', 'contact4@example.com', '555-0104', 0, 'due_at_pickup'),
  (5, 'organization', 'Lantern Street Bakery', 'contact5@example.com', '555-0105', 0, 'due_at_pickup'),
  (6, 'individual', 'Dana Whitfield', 'contact6@example.com', '555-0106', 0, 'due_at_pickup'),
  (7, 'individual', 'Marcus Oyelaran', 'contact7@example.com', '555-0107', 0, 'due_at_pickup'),
  (8, 'individual', 'Priya Nandakumar', 'contact8@example.com', '555-0108', 0, 'due_at_pickup');

INSERT INTO customer_contacts (id, customer_id, name, email, phone, title, is_primary) VALUES
  (1, 1, 'Helen Marsh', 'person1@example.com', '555-0201', 'Athletics Director', 1),
  (2, 1, 'Tom Eddings', 'person2@example.com', '555-0202', 'Front Office', 0),
  (3, 2, 'Rosa Delgado', 'person3@example.com', '555-0203', 'Band Director', 1),
  (4, 2, 'Ken Albright', 'person4@example.com', '555-0204', 'Purchasing', 0),
  (5, 3, 'Joan Pruitt', 'person5@example.com', '555-0205', 'PTA Liaison', 1),
  (6, 3, 'Sam Okafor', 'person6@example.com', '555-0206', 'Purchasing', 0),
  (7, 4, 'Lee Carver', 'person7@example.com', '555-0207', 'Club Manager', 1),
  (8, 5, 'Mina Park', 'person8@example.com', '555-0208', 'Owner', 0);

-- Orders past awaiting_materials have materials_required = 0 ("No purchasing needed"); order 16 shows purchasing
-- in progress (see the purchases below) and order 10 has a purchase drafted before authorization.
INSERT INTO orders (id, number, customer_id, contact_id, source, title, due_date, po_required, payment_terms,
  authorized_at, authorized_by, authorization_method, authorization_notes,
  artwork_required, materials_required, prep_status, items_revision, production_status, assignee_id, state, created_by) VALUES
  (1, '2026-0001', 1, 1, 'phone', 'Varsity hoodies', date('now', '-20 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'production_complete', 2, 'closed', 2),
  (2, '2026-0002', 1, 2, 'email', 'Front office polos', date('now', '-10 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'production_complete', 1, 'closed', 1),
  (3, '2026-0003', 2, 3, 'portal', 'Marching band shirts', date('now', '-3 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'ready', 2, 'active', 2),
  (4, '2026-0004', 2, 4, 'email', 'Staff appreciation caps', date('now', '+2 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'quality_control', 1, 'active', 1),
  (5, '2026-0005', 3, 5, 'phone', 'PTA spirit wear', date('now', '+5 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'ready', 2, 'active', 2),
  (6, '2026-0006', 3, 6, 'portal', 'Fun run tees', date('now', '+1 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'production_complete', 1, 'active', 1),
  (7, '2026-0007', 1, 1, 'email', 'Cross country jackets', date('now', '+9 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'not_started', 1, 'awaiting_artwork', 2, 'active', 2),
  (8, '2026-0008', 2, 3, 'phone', 'Library tote bags', date('now', '+14 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_artwork', 1, 'active', 1),
  (9, '2026-0009', 3, 5, 'portal', 'Choir shirts', date('now', '+6 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'in_progress', 1, 'awaiting_artwork', 2, 'active', 2),
  (10, '2026-0010', 1, 2, 'email', 'Robotics team hoodies', date('now', '+12 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_authorization', 1, 'active', 1),
  (11, '2026-0011', 2, 4, 'phone', 'Track team shirts', date('now', '+4 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'awaiting_authorization', 2, 'active', 2),
  (12, '2026-0012', 3, 6, 'email', 'Teacher lanyards and mugs', date('now', '+20 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'not_started', 1, 'awaiting_authorization', 1, 'active', 1),
  (13, '2026-0013', 1, 1, 'portal', 'Graduation stoles', date('now', '-2 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 0, 'ready', 1, 'awaiting_authorization', 2, 'active', 2),
  (14, '2026-0014', 2, 3, 'phone', 'Drama club hats', date('now', '+30 days'), 1, 'due_after_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 2, 'awaiting_quote', 1, 'active', 1),
  (15, '2026-0015', 4, 7, 'phone', 'Season jerseys', date('now', '-15 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 days'), 1, 'phone', 'Lee approved the mockup and price by phone.', 1, 0, 'ready', 1, 'production_complete', 2, 'closed', 2),
  (16, '2026-0016', 4, 7, 'email', 'Coach polos', date('now', '+3 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 1, 'email', 'Approval email filed with the order.', 1, 1, 'not_started', 1, 'awaiting_materials', 1, 'active', 1),
  (17, '2026-0017', 5, 8, 'portal', 'Staff aprons', date('now', '-1 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 2, 'in_person', NULL, 1, 0, 'not_required', 1, 'ready', 2, 'active', 2),
  (18, '2026-0018', 5, 8, 'phone', 'Cutting boards', date('now', '+10 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'), 1, 'signed_form', 'Customer supplies the engraving file; no artwork approval needed.', 0, 0, 'in_progress', 1, 'awaiting_preparation', 1, 'active', 1),
  (19, '2026-0019', 6, NULL, 'email', 'Family reunion tees', date('now', '+7 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), 2, 'email', NULL, 1, 0, 'ready', 1, 'quality_control', 2, 'active', 2),
  (20, '2026-0020', 6, NULL, 'portal', 'Engraved tumbler', date('now', '+0 days'), 0, 'due_at_pickup', strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), 1, 'other', 'Approved by text message.', 1, 0, 'ready', 1, 'production_complete', 1, 'active', 1),
  (21, '2026-0021', 7, NULL, 'phone', 'Wedding favors', date('now', '+16 days'), 0, 'due_at_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_authorization', 2, 'active', 2),
  (22, '2026-0022', 7, NULL, 'phone', 'Memorial plaque', date('now', '+25 days'), 0, 'due_at_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_quote', 1, 'active', 1),
  (23, '2026-0023', 8, NULL, 'email', 'Hockey bags', date('now', '+45 days'), 0, 'due_at_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_quote', 2, 'active', 2),
  (24, '2026-0024', 8, NULL, 'portal', 'Birthday hoodies', date('now', '+8 days'), 0, 'due_at_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 1, 'awaiting_quote', 1, 'cancelled', 1),
  (25, '2026-0025', 6, NULL, 'phone', 'Holiday ornaments', date('now', '+21 days'), 0, 'due_at_pickup', NULL, NULL, NULL, NULL, 1, 1, 'not_started', 0, 'awaiting_quote', 1, 'active', 1);
-- Production (0005): the marching band job runs in slot 1 with 4 of its 10 tumblers done (an in_production row must
-- hold a slot, so it is inserted ready and started here); the ready queue is placed by hand, aprons before PTA wear.
UPDATE orders SET production_status = 'in_production', production_slot = 1, units_completed = 4 WHERE id = 3;
UPDATE orders SET units_completed = 50 WHERE id = 4;
UPDATE orders SET queue_position = 1 WHERE id = 17;
UPDATE orders SET queue_position = 2 WHERE id = 5;

INSERT INTO order_items (id, order_id, kind, description, product, garment_color, method, sizes, quantity, unit_price_cents, notes) VALUES
  (1, 1, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (2, 1, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (3, 2, 'product', NULL, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (4, 2, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (5, 2, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (6, 3, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (49, 3, 'discount', 'Band booster discount', NULL, NULL, NULL, NULL, 1, 1000, NULL),
  (7, 4, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (8, 4, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (9, 5, 'product', NULL, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (10, 5, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, 'Left chest logo, 3.5 in'),
  (11, 5, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (50, 5, 'charge', 'Rush fee', NULL, NULL, NULL, NULL, 1, 5000, NULL),
  (12, 6, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (13, 7, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (14, 7, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (15, 8, 'product', NULL, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (16, 8, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (17, 8, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (18, 9, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (19, 10, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (20, 10, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (21, 11, 'product', NULL, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (22, 11, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (23, 11, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (24, 12, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (25, 13, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (26, 13, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (27, 14, 'product', NULL, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (28, 14, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (29, 14, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (30, 15, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (31, 16, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (32, 16, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (33, 17, 'product', NULL, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (34, 17, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (35, 17, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (36, 18, 'product', NULL, 'Maple cutting board', NULL, 'laser_engrave', NULL, 24, 3500, NULL),
  (37, 19, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"M":20,"L":24,"XL":10}', 54, 2400, NULL),
  (38, 19, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 15, 1800, NULL),
  (39, 20, 'product', NULL, 'Hoodie', 'Heather Gray', 'dtg', '{"S":6,"M":14,"L":14,"XL":6}', 40, 3200, NULL),
  (40, 20, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 15, 2500, NULL),
  (41, 20, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"M":20,"L":24,"XL":10}', 54, 1200, NULL),
  (42, 21, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 10, 1800, NULL),
  (43, 22, 'product', NULL, 'Acrylic sign', NULL, 'laser_cut', NULL, 10, 2500, NULL),
  (44, 22, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":6,"M":14,"L":14,"XL":6}', 40, 1200, NULL),
  (45, 23, 'product', NULL, 'Lanyard', NULL, 'other', NULL, 10, 600, NULL),
  (46, 23, 'product', NULL, 'Polo shirt', 'Navy', 'embroidery', '{"S":12,"M":30,"L":18}', 60, 2400, NULL),
  (47, 23, 'product', NULL, 'Tumbler', NULL, 'laser_engrave', NULL, 20, 1800, NULL),
  (48, 24, 'product', NULL, 'Gildan tee', 'Black', 'screen', '{"S":12,"M":30,"L":18}', 60, 1200, NULL),
  (51, 25, 'product', NULL, 'Acrylic ornament', NULL, 'laser_cut', NULL, 30, 900, NULL);

-- Quotes: inserted as drafts, their lines copied from the order's items (the frozen snapshot), totals
-- summed from the lines, then moved through the same transitions the app makes.
-- Statuses: 1-21 accepted (14's items changed after acceptance); 22 sent; 23 superseded by 24 (draft); 25 declined.
INSERT INTO quotes (id, order_id, version, items_revision, created_by) VALUES
  (1, 1, 1, 1, 2), (2, 2, 1, 1, 1), (3, 3, 1, 1, 2), (4, 4, 1, 1, 1), (5, 5, 1, 1, 2), (6, 6, 1, 1, 1), (7, 7, 1, 1, 2),
  (8, 8, 1, 1, 1), (9, 9, 1, 1, 2), (10, 10, 1, 1, 1), (11, 11, 1, 1, 2), (12, 12, 1, 1, 1), (13, 13, 1, 1, 2), (14, 14, 1, 1, 1),
  (15, 15, 1, 1, 2), (16, 16, 1, 1, 1), (17, 17, 1, 1, 2), (18, 18, 1, 1, 1), (19, 19, 1, 1, 2), (20, 20, 1, 1, 1), (21, 21, 1, 1, 2),
  (22, 22, 1, 1, 1), (23, 23, 1, 1, 2), (24, 23, 2, 1, 2), (25, 24, 1, 1, 1);
INSERT INTO quote_items (quote_id, position, kind, description, product, garment_color, method, sizes, quantity, unit_price_cents, line_total_cents)
SELECT q.id, ROW_NUMBER() OVER (PARTITION BY q.id ORDER BY i.id), i.kind, i.description, i.product, i.garment_color, i.method, i.sizes,
  i.quantity, i.unit_price_cents, CASE i.kind WHEN 'discount' THEN -(i.quantity * i.unit_price_cents) ELSE i.quantity * i.unit_price_cents END
FROM quotes q JOIN order_items i ON i.order_id = q.order_id;
-- Version 2 of the hockey bags quote drops the polo price.
UPDATE quote_items SET unit_price_cents = 2200, line_total_cents = quantity * 2200 WHERE quote_id = 24 AND product = 'Polo shirt';
UPDATE quotes SET
  subtotal_cents = COALESCE((SELECT SUM(line_total_cents) FROM quote_items WHERE quote_id = quotes.id AND kind = 'product'), 0),
  charges_cents = COALESCE((SELECT SUM(line_total_cents) FROM quote_items WHERE quote_id = quotes.id AND kind = 'charge'), 0),
  discounts_cents = COALESCE(-(SELECT SUM(line_total_cents) FROM quote_items WHERE quote_id = quotes.id AND kind = 'discount'), 0),
  total_cents = COALESCE((SELECT SUM(line_total_cents) FROM quote_items WHERE quote_id = quotes.id), 0);
UPDATE quotes SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-35 days') WHERE id <> 24;
UPDATE quotes SET status = 'sent', sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') WHERE id <> 24;
UPDATE quotes SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days') WHERE id = 22;
UPDATE quotes SET status = 'accepted', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-28 days') WHERE id <= 21;
UPDATE quotes SET status = 'superseded', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days') WHERE id = 23;
UPDATE quotes SET status = 'declined', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-9 days') WHERE id = 25;
-- After acceptance the drama club asked for six more hoodies: a customer-facing change, so items_revision is 2.
UPDATE order_items SET sizes = '{"S":6,"M":16,"L":16,"XL":8}', quantity = 46 WHERE id = 27;

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

-- Fictional placeholder files (nothing in R2); uploads arrive in M2.
INSERT INTO files (id, r2_key, mime, bytes, sha256, uploaded_by) VALUES
  (1, 'seed/artwork-1.png', 'image/png', 1024, 'seed1', 1), (2, 'seed/artwork-2.png', 'image/png', 1024, 'seed2', 1),
  (3, 'seed/artwork-3.png', 'image/png', 1024, 'seed3', 1), (4, 'seed/artwork-4.png', 'image/png', 1024, 'seed4', 1),
  (5, 'seed/artwork-5.png', 'image/png', 1024, 'seed5', 1), (6, 'seed/artwork-6.png', 'image/png', 1024, 'seed6', 1),
  (7, 'seed/artwork-7.png', 'image/png', 1024, 'seed7', 1), (8, 'seed/artwork-8.png', 'image/png', 1024, 'seed8', 1),
  (9, 'seed/artwork-9.png', 'image/png', 1024, 'seed9', 1), (10, 'seed/artwork-10.png', 'image/png', 1024, 'seed10', 1),
  (11, 'seed/artwork-11.png', 'image/png', 1024, 'seed11', 1), (12, 'seed/artwork-12.png', 'image/png', 1024, 'seed12', 1),
  (13, 'seed/artwork-13.png', 'image/png', 1024, 'seed13', 1), (14, 'seed/artwork-14.png', 'image/png', 1024, 'seed14', 1),
  (15, 'seed/artwork-15.png', 'image/png', 1024, 'seed15', 1), (16, 'seed/artwork-16.png', 'image/png', 1024, 'seed16', 1),
  (17, 'seed/artwork-17.png', 'image/png', 1024, 'seed17', 1), (19, 'seed/artwork-19.png', 'image/png', 1024, 'seed19', 1),
  (20, 'seed/artwork-20.png', 'image/png', 1024, 'seed20', 1), (21, 'seed/artwork-21.png', 'image/png', 1024, 'seed21', 1),
  (24, 'seed/artwork-24.png', 'image/png', 1024, 'seed24', 1), (105, 'seed/artwork-105.png', 'image/png', 1024, 'seed105', 1),
  (107, 'seed/artwork-107.png', 'image/png', 1024, 'seed107', 1);

-- One design per order (lineage = artwork id), except: order 5 has two approved designs; order 7's design
-- is on version 2 after changes were requested on version 1. Orders 8, 22, 23 and 25 have none yet; 18 needs none.
INSERT INTO artwork (id, customer_id, order_id, lineage_id, version, file_id, approval_status, approved_at, approved_via, approval_recorded_by) VALUES
  (1, 1, 1, 1, 1, 1, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-27 days'), 'email', 2),
  (2, 1, 2, 2, 1, 2, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-27 days'), 'email', 1),
  (3, 2, 3, 3, 1, 3, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-27 days'), 'email', 2),
  (4, 2, 4, 4, 1, 4, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-27 days'), 'phone', 1),
  (5, 3, 5, 5, 1, 5, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days'), 'email', 2),
  (105, 3, 5, 105, 1, 105, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-19 days'), 'in_person', 2),
  (6, 3, 6, 6, 1, 6, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-27 days'), 'email', 1),
  (7, 1, 7, 7, 1, 7, 'changes_requested', NULL, NULL, NULL),
  (107, 1, 7, 7, 2, 107, 'under_review', NULL, NULL, NULL),
  (9, 3, 9, 9, 1, 9, 'changes_requested', NULL, NULL, NULL),
  (10, 1, 10, 10, 1, 10, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), 'email', 1),
  (11, 2, 11, 11, 1, 11, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), 'signed_form', 2),
  (12, 3, 12, 12, 1, 12, 'under_review', NULL, NULL, NULL),
  (13, 1, 13, 13, 1, 13, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), 'email', 2),
  (14, 2, 14, 14, 1, 14, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), 'email', 1),
  (15, 4, 15, 15, 1, 15, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 days'), 'phone', 2),
  (16, 4, 16, 16, 1, 16, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 'email', 1),
  (17, 5, 17, 17, 1, 17, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 'in_person', 2),
  (19, 6, 19, 19, 1, 19, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), 'email', 2),
  (20, 6, 20, 20, 1, 20, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), 'other', 1),
  (21, 7, 21, 21, 1, 21, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'phone', 2),
  (24, 8, 24, 24, 1, 24, 'changes_requested', NULL, NULL, NULL);

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
  ('user', 2, 'order', 1, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 1, 'production_status_changed', '{"production_status":"quality_control"}', '{"production_status":"production_complete"}'),
  ('user', 1, 'order', 2, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 2, 'production_status_changed', '{"production_status":"quality_control"}', '{"production_status":"production_complete"}'),
  ('user', 2, 'order', 3, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 3, 'production_status_changed', '{"production_status":"ready"}', '{"production_status":"in_production"}'),
  ('user', 1, 'order', 4, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 4, 'production_status_changed', '{"production_status":"in_production"}', '{"production_status":"quality_control"}'),
  ('user', 2, 'order', 5, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 5, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"ready"}'),
  ('user', 1, 'order', 6, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 6, 'production_status_changed', '{"production_status":"quality_control"}', '{"production_status":"production_complete"}'),
  ('user', 2, 'order', 7, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 7, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 1, 'order', 8, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 8, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 2, 'order', 9, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 9, 'production_status_changed', '{"production_status":"awaiting_authorization"}', '{"production_status":"awaiting_artwork"}'),
  ('user', 1, 'order', 10, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 11, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 12, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 13, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 14, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 15, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 15, 'production_status_changed', '{"production_status":"quality_control"}', '{"production_status":"production_complete"}'),
  ('user', 1, 'order', 16, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 16, 'production_status_changed', '{"production_status":"awaiting_quote"}', '{"production_status":"awaiting_materials"}'),
  ('user', 2, 'order', 17, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 17, 'production_status_changed', '{"production_status":"awaiting_artwork"}', '{"production_status":"ready"}'),
  ('user', 1, 'order', 18, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 18, 'production_status_changed', '{"production_status":"awaiting_quote"}', '{"production_status":"awaiting_preparation"}'),
  ('user', 2, 'order', 19, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 19, 'production_status_changed', '{"production_status":"in_production"}', '{"production_status":"quality_control"}'),
  ('user', 1, 'order', 20, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 20, 'production_status_changed', '{"production_status":"quality_control"}', '{"production_status":"production_complete"}'),
  ('user', 2, 'order', 21, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 21, 'production_status_changed', '{"production_status":"awaiting_quote"}', '{"production_status":"awaiting_authorization"}'),
  ('user', 1, 'order', 22, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 2, 'order', 23, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 24, 'created', NULL, '{"production_status":"awaiting_quote"}'),
  ('user', 1, 'order', 25, 'created', NULL, '{"production_status":"awaiting_quote"}');

-- Suppliers come from migration 0004 (JDS, the default, id 1) and are never wiped here.
-- Order 16: a cancelled purchase (wrong colour), the replacement ordered and 30 of 40 received, and acrylic blanks not
-- ordered yet, so it stays awaiting_materials. Order 10: a purchase drafted before authorization.
INSERT INTO order_purchases (id, order_id, supplier_id, description, quantity, sizes, estimated_unit_cost_cents, actual_unit_cost_cents, status, ordered_on, expected_on, notes, created_by) VALUES
  (1, 16, 1, 'Gildan 5000 tee, Navy', 40, '{"S":6,"M":14,"L":14,"XL":6}', 350, NULL, 'ordered', date('now', '-6 days'), NULL, 'Ordered the wrong colour.', 1),
  (2, 16, 1, 'Gildan 5000 tee, Black', 40, '{"S":6,"M":14,"L":14,"XL":6}', 350, 365, 'ordered', date('now', '-5 days'), date('now', '+1 days'), NULL, 1),
  (3, 16, 1, 'Acrylic sign blanks, 8x10', 10, NULL, 600, NULL, 'not_ordered', NULL, date('now', '+4 days'), NULL, 1),
  (4, 10, 1, 'Gildan 5000 tee, Black', 40, '{"S":6,"M":14,"L":14,"XL":6}', 350, NULL, 'not_ordered', NULL, NULL, 'Order once the PO is approved.', 1);
INSERT INTO purchase_receipts (id, purchase_id, quantity, sizes, received_on, notes, recorded_by) VALUES
  (1, 2, 30, '{"S":6,"M":14,"L":10}', date('now', '-1 days'), 'XL and 4 L on back order.', 1);
UPDATE order_purchases SET status = 'cancelled' WHERE id = 1;

-- Pickups and payments (0006). Closed = picked up AND paid, so the closed orders are made active while their pickup is
-- recorded (only an active, production_complete order takes one) and closed again after.
--   1  district, paid by a check collected, deposited and cleared; picked up.     2  district, paid by ACH; picked up.
--   15 regular, paid by card at pickup, plus a cash entry voided as a duplicate.  6  district, picked up unpaid, check ready.
--   20 regular, ready and notified, a cash deposit paid (partially paid).
UPDATE orders SET state = 'active' WHERE id IN (1, 2, 15);
INSERT INTO check_collections (id, order_id, expected_cents, check_number, status, available_on, notes, created_by) VALUES
  (1, 1, 156600, '10442', 'ready_for_collection', date('now', '-12 days'), NULL, 1),
  (2, 6, 72000, NULL, 'ready_for_collection', date('now', '-2 days'), 'Pick up at the district office, front desk.', 2);
UPDATE check_collections SET status = 'collected', amount_received_cents = 156600, collected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-11 days'), collected_by = 2 WHERE id = 1;
INSERT INTO payments (id, order_id, amount_cents, method, paid_on, notes, recorded_by, request_id, check_collection_id) VALUES
  (1, 1, 156600, 'check', date('now', '-11 days'), NULL, 2, NULL, 1),
  (2, 2, 230300, 'ach', date('now', '-6 days'), 'Remittance from the district office.', 1, 'seed-payment-2', NULL),
  (3, 15, 1800, 'cash', date('now', '-14 days'), NULL, 2, 'seed-payment-3', NULL),
  (4, 15, 18000, 'card', date('now', '-14 days'), NULL, 2, 'seed-payment-4', NULL),
  (5, 20, 50000, 'cash', date('now', '-9 days'), 'Deposit when the order was placed.', 1, 'seed-payment-5', NULL);
-- The void's activity row comes from the payments_void_log trigger.
UPDATE payments SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days'), voided_by = 1, void_reason = 'Entered by mistake; the card payment covers it.' WHERE id = 3;
UPDATE check_collections SET status = 'deposited', deposited_on = date('now', '-10 days') WHERE id = 1;
UPDATE check_collections SET status = 'cleared', cleared_on = date('now', '-7 days') WHERE id = 1;
INSERT INTO pickups (order_id, ready_on, notified_on, notification_method, picked_up_on, collected_by_name, completed_by) VALUES
  (1, date('now', '-20 days'), date('now', '-20 days'), 'email', date('now', '-18 days'), 'Helen Marsh', 2),
  (2, date('now', '-10 days'), date('now', '-10 days'), 'phone', date('now', '-9 days'), 'Tom Eddings', 1),
  (15, date('now', '-15 days'), date('now', '-15 days'), 'text', date('now', '-14 days'), 'Lee Carver', 2),
  (6, date('now', '-7 days'), date('now', '-7 days'), 'email', date('now', '-5 days'), 'Sam Okafor', 1),
  (20, date('now', '-1 days'), date('now', '-1 days'), 'phone', NULL, NULL, NULL);
UPDATE orders SET state = 'closed' WHERE id IN (1, 2, 15);
INSERT INTO activity_log (actor_kind, actor_id, entity_type, entity_id, action, before, after) VALUES
  ('user', 2, 'order', 1, 'check_collected', NULL, '{"payment_id":1,"check_collection_id":1,"amount_cents":156600}'),
  ('user', 2, 'order', 1, 'pickup_collected', NULL, '{"collected_by_name":"Helen Marsh","override":false}'),
  ('user', 2, 'order', 1, 'order_closed', '{"state":"active"}', '{"state":"closed","reason":"picked_up"}'),
  ('user', 1, 'order', 6, 'pickup_collected', NULL, '{"collected_by_name":"Sam Okafor","override":false}'),
  ('user', 1, 'order', 20, 'pickup_notified', NULL, '{"notification_method":"phone"}');

-- Backdate part of the data so the dashboard sub-lines ("new this week", "waiting 5+ days") have something to say.
UPDATE orders SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') WHERE id <= 12;

-- The order-number counter for the current year. The sample numbers are 2026's; any other year starts at 1.
INSERT INTO counters (name, year, next) VALUES
  ('order', CAST(strftime('%Y', 'now') AS INTEGER), CASE strftime('%Y', 'now') WHEN '2026' THEN 26 ELSE 1 END);
