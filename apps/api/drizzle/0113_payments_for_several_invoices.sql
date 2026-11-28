DROP INDEX "invoice_payments_stripe_idx";--> statement-breakpoint
DROP INDEX "payment_refunds_stripe_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_stripe_idx" ON "invoice_payments" USING btree ("stripe_payment_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_stripe_idx" ON "payment_refunds" USING btree ("stripe_refund_id","payment_id");