-- HR: manages the People tab and reads every report, without the admin's
-- settings, policy, shifts, teams or integrations. Additive: nobody holds it
-- until an admin assigns it.
ALTER TYPE "Role" ADD VALUE 'HR';
