import asyncio
import math
import random

from dtps_http import HTTPRequest
from dtps_ui.app import App
from dtps_ui.types import HTML, Event

app = App(host="0.0.0.0", port=8000, root="/app", static_dirs="./static")


async def on_redeem_click(evt: Event):
    print("Redeem button clicked")


async def on_submit_click(evt: Event):
    print("Submit button clicked")


async def on_keydown(evt: Event):
    print("Keydown: ", evt.value)


async def on_keyup(evt: Event):
    print("Keyup: ", evt.value)


@app.route("/")
async def index(request: HTTPRequest) -> HTML:
    return HTML.from_file("./templates/index.html")


@app.background
async def update():
    i = 0
    fe = app.frontend("/")

    fe.element("img.d-block.mx-auto.mb-4").style.position = "relative"

    fe.element("#redeem-button").on("click", on_redeem_click)
    fe.element("#submit-button").on("click", on_submit_click)

    fe.document.on("keydown", on_keydown, ".which")
    fe.document.on("keyup", on_keyup, ".which")

    while True:
        i += 0.01

        fe.element("img.d-block.mx-auto.mb-4").style.left = f"{int(200 * math.sin(3 * i))}px"

        fe.element("#cc-number").value = " ".join(
            [
                "".join([str(int(random.random() * 10)) for _ in range(4)])
                for __ in range(4)
            ]
        )

        await asyncio.sleep(1 / 30)


app.serve_forever()


