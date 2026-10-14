-- ===============================================================================================================
-- schema-return-reasons.sql: Centralized Canonical Return Reasons, Marketplace Mappings, and Sizing Intelligence
-- Multi-marketplace return reason standardization for Myntra, Amazon, Meesho, Flipkart, and AJio.
-- Strictly additive and idempotent. History tables are never dropped or modified destructively.
-- ===============================================================================================================

-- 1. Canonical return reasons representing unified root-cause contexts.
CREATE TABLE IF NOT EXISTS canonical_return_reasons (
  category_code text PRIMARY KEY,
  label text NOT NULL,
  department text NOT NULL,
  is_seller_fault boolean NOT NULL DEFAULT false,
  is_size_issue boolean NOT NULL DEFAULT false,
  severity text NOT NULL DEFAULT 'low',
  description text NOT NULL DEFAULT '',
  action_recommendation text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO canonical_return_reasons
  (category_code, label, department, is_seller_fault, is_size_issue, severity, description, action_recommendation, sort_order)
VALUES
  (
    'SELLER_FAULT_DEFECTIVE',
    'Defective / Damaged Merchandise',
    'Quality Control & Manufacturing',
    true,
    false,
    'high',
    'Damaged, torn, stained, defective product, stitching defect or manufacturing fault arrived at customer.',
    'Urgent: Halt lot production if clustered. Inspect batch cutting/stitching and packing station QC before release.',
    1
  ),
  (
    'SELLER_FAULT_WRONG_ITEM',
    'Wrong Item / Mis-shipment',
    'Dispatch & Packing Bench',
    true,
    false,
    'critical',
    'Completely different product, wrong color, wrong size sent, or misshipment delivered to buyer.',
    'Urgent: Inspect picker/packer barcode scanning at dispatch. Verify SKU tags match garment labels in warehouse.',
    2
  ),
  (
    'SELLER_FAULT_MISSING_ITEM',
    'Missing Components / Accessories',
    'Packing & Assembly',
    true,
    false,
    'high',
    'Incomplete package: missing dupatta, belt, accessory, or partial set contents delivered.',
    'Enforce multi-piece set verification checklist during secondary polybag packaging.',
    3
  ),
  (
    'SELLER_FAULT_QUALITY',
    'Poor Quality / Fabric / Finish Discrepancy',
    'Fabric Sourcing & Finishing',
    true,
    false,
    'medium',
    'Customer dissatisfied with product quality, fabric feel, or image looks significantly better than reality.',
    'Audit fabric GSM, hand-feel, wash durability, and catalogue photography color accuracy.',
    4
  ),
  (
    'SIZE_FIT_TOO_SMALL',
    'Size Too Small (Runs Small)',
    'Pattern & Sizing Team',
    false,
    true,
    'medium',
    'Garment fits tighter or smaller than customer expected according to size chart.',
    'Pattern revision: Review chest/waist/hip specs; consider +0.5 to +1 inch ease or advise buyers to size up.',
    5
  ),
  (
    'SIZE_FIT_TOO_LARGE',
    'Size Too Big (Runs Large)',
    'Pattern & Sizing Team',
    false,
    true,
    'medium',
    'Garment fits looser or larger than customer expected according to size chart.',
    'Pattern revision: Review ease grading; consider trimming excess garment chest/waist circumference.',
    6
  ),
  (
    'SIZE_FIT_GENERAL',
    'General Fit & Silhouette Issue',
    'Pattern & Sizing Team',
    false,
    true,
    'low',
    'Customer did not like the fit, cut, or drape of the garment.',
    'Analyze fit feedback across customer demographics to refine garment cut and silhouette styling.',
    7
  ),
  (
    'CUSTOMER_REMORSE',
    'Customer Mind Changed / Preference',
    'Merchandising & Sales',
    false,
    false,
    'low',
    'Buyer remorse: no longer needed, found cheaper elsewhere, did not suit styling/color preference, accidental order.',
    'No seller mistake. Monitor conversion and pricing competitiveness on channel.',
    8
  ),
  (
    'LOGISTICS_COURIER_RTO',
    'Logistics / Delayed / In-Transit / RTO',
    'Logistics & Carrier SLA',
    false,
    false,
    'low',
    'Delayed delivery, carrier damaged transit packaging, customer refused delivery, or cancelled before dispatch.',
    'Hold carrier accountable for transit damage and delivery SLA violations via SLA penalty claims.',
    9
  ),
  (
    'OTHER_UNKNOWN',
    'Uncategorized / Other Reason',
    'Operations',
    false,
    false,
    'low',
    'Generic reason, approval flow, or unclassified feedback.',
    'Review raw reason and map to specific canonical category if volume increases.',
    10
  )
ON CONFLICT (category_code) DO UPDATE SET
  label = EXCLUDED.label,
  department = EXCLUDED.department,
  is_seller_fault = EXCLUDED.is_seller_fault,
  is_size_issue = EXCLUDED.is_size_issue,
  severity = EXCLUDED.severity,
  description = EXCLUDED.description,
  action_recommendation = EXCLUDED.action_recommendation,
  sort_order = EXCLUDED.sort_order;

-- 2. Marketplace raw reasons to canonical category mappings.
CREATE TABLE IF NOT EXISTS marketplace_reason_mappings (
  id serial PRIMARY KEY,
  marketplace text NOT NULL,
  raw_reason text NOT NULL,
  canonical_code text NOT NULL REFERENCES canonical_return_reasons(category_code),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace, raw_reason)
);

CREATE INDEX IF NOT EXISTS marketplace_reason_mappings_lookup_idx
  ON marketplace_reason_mappings (marketplace, raw_reason);

-- 3. Seed all 105 marketplace reasons extracted from "Return Resone.xlsx" across the 5 sheets.

-- === Sheet: Myntra EJ & VB ===
INSERT INTO marketplace_reason_mappings (marketplace, raw_reason, canonical_code, notes) VALUES
  ('Myntra', 'I did not like the fit', 'SIZE_FIT_GENERAL', 'Myntra raw return_reason'),
  ('Myntra', 'I do not need it anymore', 'CUSTOMER_REMORSE', 'Myntra raw return_reason'),
  ('Myntra', 'Product image was better than the actual product', 'SELLER_FAULT_QUALITY', 'Myntra raw return_reason'),
  ('Myntra', 'Received a poor quality product', 'SELLER_FAULT_QUALITY', 'Myntra raw return_reason'),
  ('Myntra', 'Found a better price on Myntra', 'CUSTOMER_REMORSE', 'Myntra raw return_reason'),
  ('Myntra', 'Size too small', 'SIZE_FIT_TOO_SMALL', 'Myntra raw return_reason'),
  ('Myntra', 'Size too big', 'SIZE_FIT_TOO_LARGE', 'Myntra raw return_reason'),
  ('Myntra', 'Different product was delivered', 'SELLER_FAULT_WRONG_ITEM', 'Myntra raw return_reason'),
  ('Myntra', 'Received a completely different product', 'SELLER_FAULT_WRONG_ITEM', 'Myntra raw return_reason'),
  ('Myntra', 'Found a better price elsewhere', 'CUSTOMER_REMORSE', 'Myntra raw return_reason'),
  ('Myntra', 'Product was damaged', 'SELLER_FAULT_DEFECTIVE', 'Myntra raw return_reason'),
  ('Myntra', 'Color is different', 'SELLER_FAULT_WRONG_ITEM', 'Myntra raw return_reason'),
  ('Myntra', 'Size is different', 'SELLER_FAULT_WRONG_ITEM', 'Myntra raw return_reason'),
  ('Myntra', 'Product looked old', 'SELLER_FAULT_QUALITY', 'Myntra raw return_reason'),
  ('Myntra', 'Product was dirty and had stains', 'SELLER_FAULT_DEFECTIVE', 'Myntra raw return_reason'),
  ('Myntra', 'Generic Return Reason', 'OTHER_UNKNOWN', 'Myntra raw return_reason'),
  ('Myntra', 'Size is too Large', 'SIZE_FIT_TOO_LARGE', 'Myntra raw return_reason'),
  ('Myntra', 'Primary packaging damaged', 'LOGISTICS_COURIER_RTO', 'Myntra raw return_reason'),
  ('Myntra', 'Delivery was delayed', 'LOGISTICS_COURIER_RTO', 'Myntra raw return_reason'),
  ('Myntra', 'Delivery was delayed ', 'LOGISTICS_COURIER_RTO', 'Myntra raw return_reason with trailing space'),
  ('Myntra', 'Product was defective', 'SELLER_FAULT_DEFECTIVE', 'Myntra raw return_reason'),
  ('Myntra', 'Size is too Small', 'SIZE_FIT_TOO_SMALL', 'Myntra raw return_reason'),
  ('Myntra', 'Defective product was delivered', 'SELLER_FAULT_DEFECTIVE', 'Myntra raw return_reason'),
  ('Myntra', 'Return Reason - Thanos ROH approval flow', 'OTHER_UNKNOWN', 'Myntra raw return_reason'),
  ('Myntra', 'Design is different', 'SELLER_FAULT_WRONG_ITEM', 'Myntra raw return_reason')
ON CONFLICT (marketplace, raw_reason) DO UPDATE SET
  canonical_code = EXCLUDED.canonical_code,
  notes = EXCLUDED.notes;

-- === Sheet: Amazon ===
INSERT INTO marketplace_reason_mappings (marketplace, raw_reason, canonical_code, notes) VALUES
  ('Amazon', 'Too large', 'SIZE_FIT_TOO_LARGE', 'Amazon raw Return Reason'),
  ('Amazon', 'Incompatible or not useful for intended purpose', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Performance or quality not adequate', 'SELLER_FAULT_QUALITY', 'Amazon raw Return Reason'),
  ('Amazon', 'Different from what was ordered', 'SELLER_FAULT_WRONG_ITEM', 'Amazon raw Return Reason'),
  ('Amazon', 'Too small', 'SIZE_FIT_TOO_SMALL', 'Amazon raw Return Reason'),
  ('Amazon', 'Missed estimated delivery date', 'LOGISTICS_COURIER_RTO', 'Amazon raw Return Reason'),
  ('Amazon', 'Item doesn''t fit', 'SIZE_FIT_GENERAL', 'Amazon raw Return Reason'),
  ('Amazon', 'Missing parts or accessories', 'SELLER_FAULT_MISSING_ITEM', 'Amazon raw Return Reason'),
  ('Amazon', 'No longer needed/wanted', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Style not as expected', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Defective/Does not work properly', 'SELLER_FAULT_DEFECTIVE', 'Amazon raw Return Reason'),
  ('Amazon', 'Damaged due to inappropriate packaging', 'LOGISTICS_COURIER_RTO', 'Amazon raw Return Reason'),
  ('Amazon', 'Ordered wrong style/size/color', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Better price available', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Damaged during shipping', 'LOGISTICS_COURIER_RTO', 'Amazon raw Return Reason'),
  ('Amazon', 'Different from website description', 'SELLER_FAULT_WRONG_ITEM', 'Amazon raw Return Reason'),
  ('Amazon', 'Arrived in addition to what was ordered', 'LOGISTICS_COURIER_RTO', 'Amazon raw Return Reason'),
  ('Amazon', 'Did not like color', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason'),
  ('Amazon', 'Item not as shown by photo on website', 'SELLER_FAULT_QUALITY', 'Amazon raw Return Reason'),
  ('Amazon', 'Item never arrived', 'LOGISTICS_COURIER_RTO', 'Amazon raw Return Reason'),
  ('Amazon', 'Accidental order', 'CUSTOMER_REMORSE', 'Amazon raw Return Reason')
ON CONFLICT (marketplace, raw_reason) DO UPDATE SET
  canonical_code = EXCLUDED.canonical_code,
  notes = EXCLUDED.notes;

-- === Sheet: Meesho ===
INSERT INTO marketplace_reason_mappings (marketplace, raw_reason, canonical_code, notes) VALUES
  ('Meesho', 'Don''t need the product anymore', 'CUSTOMER_REMORSE', 'Meesho raw Return Reason'),
  ('Meesho', 'Have size / fit related issues', 'SIZE_FIT_GENERAL', 'Meesho raw Return Reason'),
  ('Meesho', 'Have other quality related issues', 'SELLER_FAULT_QUALITY', 'Meesho raw Return Reason'),
  ('Meesho', 'Received defective product (stains / damaged / torn)', 'SELLER_FAULT_DEFECTIVE', 'Meesho raw Return Reason'),
  ('Meesho', 'Received incomplete product (missing quantity / accessory)', 'SELLER_FAULT_MISSING_ITEM', 'Meesho raw Return Reason'),
  ('Meesho', 'Received wrong product (different color / size / product)', 'SELLER_FAULT_WRONG_ITEM', 'Meesho raw Return Reason'),
  ('Meesho', 'Customer Support', 'OTHER_UNKNOWN', 'Meesho raw Return Reason'),
  -- Live composite sub-reasons observed in database
  ('Meesho', 'Have size / fit related issues · Size correct but too tight', 'SIZE_FIT_TOO_SMALL', 'Meesho composite reason'),
  ('Meesho', 'Have size / fit related issues · Size correct but too loose', 'SIZE_FIT_TOO_LARGE', 'Meesho composite reason'),
  ('Meesho', 'Have size / fit related issues · Did not like the fit', 'SIZE_FIT_GENERAL', 'Meesho composite reason'),
  ('Meesho', 'Have other quality related issues · Product''s quality or performance is not good', 'SELLER_FAULT_QUALITY', 'Meesho composite reason'),
  ('Meesho', 'Don''t need the product anymore · Changed my mind', 'CUSTOMER_REMORSE', 'Meesho composite reason')
ON CONFLICT (marketplace, raw_reason) DO UPDATE SET
  canonical_code = EXCLUDED.canonical_code,
  notes = EXCLUDED.notes;

-- === Sheet: Flipkart ===
INSERT INTO marketplace_reason_mappings (marketplace, raw_reason, canonical_code, notes) VALUES
  ('Flipkart', 'order_cancelled', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'shield_cancellation', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'SIZE_FIT_ISSUES', 'SIZE_FIT_GENERAL', 'Flipkart raw Return Reason'),
  ('Flipkart', 'MISSHIPMENT', 'SELLER_FAULT_WRONG_ITEM', 'Flipkart raw Return Reason'),
  ('Flipkart', 'ORC_validated with customer', 'CUSTOMER_REMORSE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'CUSTOMER_REMORSE', 'CUSTOMER_REMORSE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'QUALITY_ISSUE', 'SELLER_FAULT_QUALITY', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Rejected_by_Customer', 'CUSTOMER_REMORSE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Customer rejection', 'CUSTOMER_REMORSE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Uncontrollable Factors', 'OTHER_UNKNOWN', 'Flipkart raw Return Reason'),
  ('Flipkart', 'order_cancelled_by_seller_support', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Damaged_shipment', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'DAMAGED_SHIPMENT_OBD', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Customer requested', 'CUSTOMER_REMORSE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Cancelled_By_Client_Over_API', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'DAMAGED_PRODUCT', 'SELLER_FAULT_DEFECTIVE', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Attempts_Exhausted', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'OBD_CANCELLED_WITH_OTP', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'MISSING_ITEM', 'SELLER_FAULT_MISSING_ITEM', 'Flipkart raw Return Reason'),
  ('Flipkart', 'not_serviceable', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'SMART_PICKUP_CHECK_OVERRIDE', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Client_Instructions_For_RTO', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Aged_beyond_Limit', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Other State Misroute', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Cancelled OTP validated', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Return To Origin', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  ('Flipkart', 'Shipment_EOB_Ageing', 'LOGISTICS_COURIER_RTO', 'Flipkart raw Return Reason'),
  -- Live composite sub-reasons observed in database
  ('Flipkart', 'SIZE FIT ISSUES · FIT NOT AS EXPECTED', 'SIZE_FIT_GENERAL', 'Flipkart composite reason'),
  ('Flipkart', 'QUALITY ISSUE · QUALITY NOT AS EXPECTED', 'SELLER_FAULT_QUALITY', 'Flipkart composite reason'),
  ('Flipkart', 'ORC validated with customer · ORC validated with customer', 'CUSTOMER_REMORSE', 'Flipkart composite reason'),
  ('Flipkart', 'Order cancelled · Mind changed', 'CUSTOMER_REMORSE', 'Flipkart composite reason')
ON CONFLICT (marketplace, raw_reason) DO UPDATE SET
  canonical_code = EXCLUDED.canonical_code,
  notes = EXCLUDED.notes;

-- === Sheet: AJio ===
INSERT INTO marketplace_reason_mappings (marketplace, raw_reason, canonical_code, notes) VALUES
  ('Ajio', 'Refuse_To_Accept', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Does_Not_Look_Good_On_Me', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Not_Happy_With_Product_Quality', 'SELLER_FAULT_QUALITY', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Does_Not_Fit_Well', 'SIZE_FIT_GENERAL', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Size_Is_Smaller_Than_Expected', 'SIZE_FIT_TOO_SMALL', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Size_Is_Larger_than_Expected', 'SIZE_FIT_TOO_LARGE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Received_Damaged', 'SELLER_FAULT_DEFECTIVE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Virtual_Shipped', 'LOGISTICS_COURIER_RTO', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Product_Not_Required_Anymore', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Did_Not_Like_Color', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Ordered_By_Mistake', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Did_Not_Like_The_Product', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Size_Smaller_Than_Expected', 'SIZE_FIT_TOO_SMALL', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Received_Defective_Merchandise', 'SELLER_FAULT_DEFECTIVE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Different_Product_Delivered', 'SELLER_FAULT_WRONG_ITEM', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Want_To_Change_Style_Color', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Others', 'CUSTOMER_REMORSE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Size_Larger_Than_Expected', 'SIZE_FIT_TOO_LARGE', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Product_Not_As_Displayed_On_Website', 'SELLER_FAULT_QUALITY', 'AJio raw Cust Return Reason'),
  ('Ajio', 'Delivered_Wrong_Size', 'SELLER_FAULT_WRONG_ITEM', 'AJio raw Cust Return Reason')
ON CONFLICT (marketplace, raw_reason) DO UPDATE SET
  canonical_code = EXCLUDED.canonical_code,
  notes = EXCLUDED.notes;

-- 4. Purely additive columns on expected_returns for high-performance direct indexing and filtering.
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS canonical_reason_code text REFERENCES canonical_return_reasons(category_code);
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS is_seller_fault boolean;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS is_size_issue boolean;
ALTER TABLE expected_returns ADD COLUMN IF NOT EXISTS detected_size text;

CREATE INDEX IF NOT EXISTS expected_returns_canonical_reason_idx ON expected_returns (canonical_reason_code);
CREATE INDEX IF NOT EXISTS expected_returns_seller_fault_idx ON expected_returns (is_seller_fault) WHERE is_seller_fault = true;
CREATE INDEX IF NOT EXISTS expected_returns_size_issue_idx ON expected_returns (is_size_issue) WHERE is_size_issue = true;
CREATE INDEX IF NOT EXISTS expected_returns_detected_size_idx ON expected_returns (detected_size) WHERE detected_size IS NOT NULL;
