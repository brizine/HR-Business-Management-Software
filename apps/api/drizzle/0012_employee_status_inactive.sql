-- "terminated" is now called "inactive".
UPDATE "employees" SET "status" = 'inactive' WHERE "status" = 'terminated';
