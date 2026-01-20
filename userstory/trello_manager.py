import requests
import os
import sys

# ----------------------------
# CONFIG
# ----------------------------
API_KEY = "01093e5f735478f28c0df83a7e87155f"
API_TOKEN = "ATTA79595614b3d0393d15958f3bb12494957078eab5fb76a1ed61ea332dbb719f9d81C2D2EF"
BOARD_ID = "6939081e462f8b9abf62c36e"

BASE_URL = "https://api.trello.com/1"


# ----------------------------
# HELPER FUNCTIONS
# ----------------------------

def trello_get(endpoint, params=None):
    url = f"{BASE_URL}/{endpoint}"
    params = params or {}
    params.update({"key": API_KEY, "token": API_TOKEN})
    r = requests.get(url, params=params)
    r.raise_for_status()
    return r.json()


def trello_put(endpoint, params=None):
    url = f"{BASE_URL}/{endpoint}"
    params = params or {}
    params.update({"key": API_KEY, "token": API_TOKEN})
    r = requests.put(url, params=params)
    r.raise_for_status()
    return r.json()


def get_board_lists(board_id):
    return trello_get(f"boards/{board_id}/lists")


def get_list_cards(list_id):
    return trello_get(f"lists/{list_id}/cards")


def move_card(card_id, target_list_id):
    return trello_put(f"cards/{card_id}", {"idList": target_list_id})


# ----------------------------
# MAIN PROGRAM
# ----------------------------

def main():
    print("\nTRELLO CARD MOVER — Pick ANY card and move it to Doing/Done\n")

    # Fetch lists in board
    lists = get_board_lists(BOARD_ID)

    # Identify Doing and Done list IDs
    doing_list = next((lst for lst in lists if lst["name"] == "Doing"), None)
    done_list = next((lst for lst in lists if lst["name"] == "Done"), None)

    if not doing_list or not done_list:
        print("ERROR: Board must contain lists named 'Doing' and 'Done'")
        return

    # Collect all cards from all lists
    all_cards = []
    print("Fetching cards...")

    for lst in lists:
        cards = get_list_cards(lst["id"])
        for card in cards:
            all_cards.append({
                "id": card["id"],
                "name": card["name"],
                "list": lst["name"]
            })

    if not all_cards:
        print("No cards found on this board!")
        return

    # Display all cards
    print("\nALL CARDS:")
    for i, card in enumerate(all_cards):
        print(f"{i+1}. {card['name']}  —  ({card['list']})")

    # User selects card
    choice = int(input("\n👉 Select card number to move: ")) - 1
    selected = all_cards[choice]

    print(f"\nSelected: {selected['name']}  (from {selected['list']})")

    # Choose target list
    print("\nMove card to:")
    print("1. Doing")
    print("2. Done")

    choice2 = input("\nEnter choice: ")

    if choice2 == "1":
        move_card(selected["id"], doing_list["id"])
        print(f"\n🚀 Card moved to DOING!")
    elif choice2 == "2":
        move_card(selected["id"], done_list["id"])
        print(f"\n🏁 Card moved to DONE!")
    else:
        print("Invalid selection")
        return


if __name__ == "__main__":
    main()
