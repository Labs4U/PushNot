import boto3
import random
import sys
from decimal import Decimal
from datetime import datetime, timezone

# ─── Configuration ────────────────────────────────────────────────────────────
TABLE_NAME        = "PushNotSystem-oelmemu3trbujlx5bcvzmfj3gi-NONE"
REGION_NAME       = "us-east-1"
NUMBER_OF_MEMBERS = 50   # Change to generate more or fewer members

# The partition key for all seeded members.
# Pass your real Cognito sub as the first CLI argument so members align with
# the logged-in tenant:
#
#   python membersSeed.py ASSOC#<your-cognito-sub>
#
# Your Cognito sub is printed to the browser console after login:
#   🔄 Fetching members for tenant: ASSOC#xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
#
# Falls back to the legacy static ID only for local unit testing.
ASSOCIATION_ID = sys.argv[1] if len(sys.argv) > 1 else "ASSOC#101"

# ─── Data arrays for randomization ───────────────────────────────────────────
MALE_NAMES   = ["Ahmed", "Mohamed", "Omar", "Khalid", "Hussain",
                "Isa", "Ali", "Hassan", "Sayed", "Yusuf"]
FEMALE_NAMES = ["Fatima", "Zainab", "Noor", "Mariam", "Aisha",
                "Sara", "Huda", "Mona", "Amira", "Layla"]
LAST_NAMES   = ["Ali", "Hassan", "Amin", "Yusuf", "Salman",
                "Ebrahim", "Jassim", "Tariq", "Adel", "Majeed"]
REGIONS  = ["A'ali", "Manama", "Muharraq", "Riffa",
            "Isa Town", "Hamad Town", "Sitra", "Budaiya"]
PERSONAS = ["CLICKER", "CHATTER", "PASSIVE"]

# ─── Seed ─────────────────────────────────────────────────────────────────────

def seed_random_members():
    dynamodb = boto3.resource('dynamodb', region_name=REGION_NAME)
    table    = dynamodb.Table(TABLE_NAME)

    print(f"Seeding {NUMBER_OF_MEMBERS} members into {TABLE_NAME}")
    print(f"Tenant (pk): {ASSOCIATION_ID}\n")

    # Single timestamp for the entire batch — keeps createdAt consistent
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    success_count = 0

    with table.batch_writer() as batch:
        for i in range(1, NUMBER_OF_MEMBERS + 1):
            gender     = random.choice(["MALE", "FEMALE"])
            first_name = random.choice(MALE_NAMES if gender == "MALE" else FEMALE_NAMES)
            last_name  = random.choice(LAST_NAMES)
            phone      = f"9733300{i:04d}"
            region     = random.choice(REGIONS)
            persona    = random.choice(PERSONAS)

            engagement = round(random.uniform(0, 100), 1)
            conversion = round(random.uniform(0, engagement), 1)
            lifetime   = 0.0 if conversion < 1.0 else round(random.uniform(10, 5000), 1)

            item = {
                # ── Keys ──────────────────────────────────────────────────
                "pk":  ASSOCIATION_ID,
                "sk":  f"MEM#{phone}",

                # ── Amplify Gen 2 managed timestamps (non-nullable in AppSync) ──
                # Must be set manually when writing via boto3 to avoid
                # "Cannot return null for non-nullable type: AWSDateTime" errors.
                "createdAt":  now_iso,
                "updatedAt":  now_iso,

                # ── Amplify / AppSync metadata ─────────────────────────────
                # __typename is required for Amplify to expose records via list()
                "__typename": "PushNotSystem",

                # ── Entity classification ──────────────────────────────────
                "entityType": "MEMBER",

                # ── Member profile fields ──────────────────────────────────
                "name":    f"{first_name} {last_name}",
                "phone":   phone,
                "address": region,
                "gender":  gender,

                # ── Engagement stats (Decimal required by boto3 for floats) ──
                "engagementRatePercent":      Decimal(str(engagement)),
                "conversionRatePercent":      Decimal(str(conversion)),
                "lifetimeContributionAmount": Decimal(str(lifetime)),
                "interactionPersona":         persona,
            }

            try:
                batch.put_item(Item=item)
                success_count += 1
                if success_count % 10 == 0:
                    print(f"  Queued {success_count} members...")
            except Exception as e:
                print(f"  ❌ Failed to queue {item['name']}: {e}")

    print(f"\n✅ Seeded {success_count}/{NUMBER_OF_MEMBERS} members")
    print(f"   pk = {ASSOCIATION_ID}")
    print(f"   createdAt/updatedAt = {now_iso}")
    print("\nNext steps:")
    print("  1. Open the app and log in")
    print("  2. Open browser console — look for:")
    print("     '🔄 Fetching members for tenant: ASSOC#...'")
    print("  3. Copy that full ASSOC#... value")
    print("  4. Re-run: python membersSeed.py ASSOC#<your-cognito-sub>")

if __name__ == "__main__":
    seed_random_members()
