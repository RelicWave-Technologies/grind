-- Date of birth on a person.
--
-- IF NOT EXISTS because production already carries this column: it was added
-- there by hand, ahead of any migration. Without the guard `migrate deploy`
-- fails on the very environment the column was added for.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthDate" DATE;
